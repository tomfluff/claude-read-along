import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput } from 'claude-code'

import type { ReadAloudCursor, ReadAloudSettings, ReadAloudStatus } from '../types'

// Read-aloud: buttons on every message, a band while reading, auto-read, and
// the sentence being read marked in its message.
// The speech itself is bin/speakd.py, one local service per user that every
// session shares (so only one voice talks at a time), reached over HTTP on a
// Unix socket. A voice is a Kokoro name (af_heart) or `win:<Windows voice>`.

const now = atom({ plugin: 'read-aloud', key: 'now' } as const, null)
const current = atom({ plugin: 'read-aloud', key: 'prefs' } as const, null)
const cursor = atom({ plugin: 'read-aloud', key: 'cursor' } as const, null)

const PANE = 'read-aloud'
const SPEED_STEP = 0.25
const VOLUME_STEP = 10
/**
 * The player's status icon, by state. `nerd` uses Nerd Font icons (speaker,
 * pause, hourglass), as WezTerm draws them from JetBrainsMono Nerd Font;
 * `text` uses plain symbols for a terminal without one.
 */
const ICONS = {
  nerd: { idle: '\u{F057E}', playing: '\u{F057E}', paused: '\u{F03E4}', loading: '\u{F051F}' },
  text: { idle: '♫', playing: '♫', paused: '‖', loading: '…' },
} as const
const icon = (state: 'idle' | 'playing' | 'paused' | 'loading') => ICONS[str('icons', 'nerd') === 'text' ? 'text' : 'nerd'][state]
const stateOf = (status: ReadAloudStatus) => (status.state === 'paused' ? 'paused' : status.state === 'loading' ? 'loading' : 'playing')
const DUCK_LEVELS = ['off', '50%', '30%', '15%']
/** Other apps' volume while reading, as a fraction of their own: `30%` → 0.3, `off` → 1. */
const duckLevel = (duckOthers: string) => (duckOthers === 'off' ? 1 : Math.max(0, Math.min(1, parseFloat(duckOthers) / 100 || 1)))

type $ = EngineInterface
type Options = Readonly<Record<string, string | number | boolean | readonly string[]>>
type MessageEvent = RenderInput<'AssistantMessage' | 'UserMessage'>
type Lang = 'en' | 'ja' | 'he'

const LANGS: { lang: Lang; name: string; field: 'voice' | 'jaVoice' | 'heVoice'; list: 'voices' | 'jaVoices' | 'heVoices' }[] = [
  { lang: 'en', name: 'English', field: 'voice', list: 'voices' },
  { lang: 'ja', name: 'Japanese', field: 'jaVoice', list: 'jaVoices' },
  { lang: 'he', name: 'Hebrew', field: 'heVoice', list: 'heVoices' },
]

let opt: Options = {}
const str = (k: string, d: string) => (typeof opt[k] === 'string' ? (opt[k] as string) : d)
const num = (k: string, d: number) => (typeof opt[k] === 'number' ? (opt[k] as number) : d)
const bool = (k: string, d: boolean) => (typeof opt[k] === 'boolean' ? (opt[k] as boolean) : d)
const list = (k: string, d: string) =>
  str(k, d)
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)

const defaults = (): ReadAloudSettings => ({
  voice: str('englishVoice', 'af_heart'),
  voices: list('englishVoices', 'af_heart,am_fenrir,bf_emma'),
  jaVoice: str('japaneseVoice', 'win:Microsoft Nanami Native'),
  jaVoices: list('japaneseVoices', 'win:Microsoft Nanami Native,win:Microsoft Keita Native,jf_alpha,jm_kumo'),
  heVoice: str('hebrewVoice', 'win:Microsoft Hila Native'),
  heVoices: list('hebrewVoices', 'win:Microsoft Hila Native'),
  speed: num('speed', 2.5),
  volume: num('volume', 100),
  duckOthers: str('duckOthers', 'off'),
  autoReadReplies: str('autoReadReplies', 'off'),
  autoReadMine: bool('autoReadMine', false),
})
const buttons = () => str('buttons', 'hover')
/** Where a read's progress and controls show: the band above the prompt, under the message, or both. */
const controlsAt = () => str('controls', 'bottom')

let socketPath = ''
let isEnsured = false
let lastError: string | null | undefined

// ------------------------------------------------------------ the service

async function sock($: $) {
  if (!socketPath) socketPath = `/tmp/read-aloud-${(await $.env.get('USER')) ?? 'user'}.sock`
  return socketPath
}

async function ensure($: $) {
  if (isEnsured) return
  const run = await $.process.run(
    [str('python', 'python3'), '-I', `${$.plugin.root}/bin/speakd.py`, '--ensure', '--socket', await sock($)],
    { timeoutMs: 20000 },
  )
  if (run.exitCode !== 0) throw new Error(`speech service didn't start: ${run.stdout || run.stderr}`)
  isEnsured = true
}

async function call($: $, path: string, body?: unknown): Promise<ReadAloudStatus> {
  const go = async () => {
    const res = await $.http.fetch(`http://speakd${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      socketPath: await sock($),
    })
    return JSON.parse(res.text) as ReadAloudStatus
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

async function settings($: $) {
  return { ...defaults(), ...((await read($, current)) ?? {}) }
}

function setSettings($: $, change: Partial<ReadAloudSettings>) {
  return update($, current, s => ({ ...defaults(), ...(s ?? {}), ...change }))
}

/**
 * Writes the service's status into state, and only what changed: every write
 * redraws its readers, and every message row reads \`cursor\`, so an
 * unchanged write (the idle check every 3 s) redrew the whole transcript and
 * made it jitter when it met a message being sent.
 */
async function show($: $, status: ReadAloudStatus) {
  const isIdle = status.state === 'idle' && !status.queue
  const nextNow = isIdle ? null : status
  if (JSON.stringify(await read($, now)) !== JSON.stringify(nextNow)) await update($, now, () => nextNow)
  const nextCursor: ReadAloudCursor | null = isIdle || !status.key ? null : { key: status.key, text: status.text ?? '' }
  const at = await read($, cursor)
  if (at?.key !== nextCursor?.key || at?.text !== nextCursor?.text) await update($, cursor, () => nextCursor)
  if (status.error && status.error !== lastError) $.ui.toast(`Read aloud: ${status.error}`)
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
  if (!isActive && ticks % 8 !== 0) return
  try {
    const res = await $.http.fetch('http://speakd/status', { socketPath: await sock($) })
    const status = JSON.parse(res.text) as ReadAloudStatus
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
      voice: s.voice,
      jaVoice: s.jaVoice,
      heVoice: s.heVoice,
      readCode: bool('readCode', false),
    })
    await show($, status)
    poll()
  } catch (err) {
    $.ui.toast(`Read aloud: ${String(err)}`)
  }
}

async function control($: $, action: string) {
  try {
    await show($, await call($, '/control', { action }))
    poll()
  } catch (err) {
    $.ui.toast(`Read aloud: ${String(err)}`)
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

/** The voice button on a message: the next English voice. */
async function nextVoice($: $) {
  const s = await settings($)
  const voices = s.voices.length ? s.voices : [s.voice]
  await setVoice($, 'en', voices[(voices.indexOf(s.voice) + 1) % voices.length] ?? s.voice)
}

async function setVoice($: $, lang: Lang, voice: string) {
  const field = LANGS.find(l => l.lang === lang)?.field ?? 'voice'
  await setSettings($, { [field]: voice })
  if (await read($, now)) await show($, await call($, '/set', { [field]: voice }))
}

async function saveDefaults($: $) {
  const s = await settings($)
  const fields: [string, string | number | boolean][] = [
    ['englishVoice', s.voice],
    ['japaneseVoice', s.jaVoice],
    ['hebrewVoice', s.heVoice],
    ['speed', s.speed],
    ['volume', s.volume],
    ['duckOthers', s.duckOthers],
    ['autoReadReplies', s.autoReadReplies],
    ['autoReadMine', s.autoReadMine],
  ]
  const refused: string[] = []
  for (const [field, value] of fields) {
    const { deny } = await $.config.set({ key: `read-aloud.${field}`, value })
    if (deny) refused.push(`${field} (${deny})`)
  }
  return refused.length ? `Not saved: ${refused.join(', ')}` : 'Saved as the defaults for new sessions.'
}

// ------------------------------------------------------------ text helpers

const clock = (seconds = 0) => {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const bar = (fraction: number, width: number) => {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width)
  return '━'.repeat(filled) + '─'.repeat(width - filled)
}

const KOKORO_NAMES: Record<string, string> = { af: 'US', am: 'US', bf: 'UK', bm: 'UK', jf: 'JP', jm: 'JP' }

/** `af_heart` → heart, `win:Microsoft Ava Native` → Ava (Windows). */
const voiceName = (voice = '', isLong = false) => {
  const win = voice.replace(/^win:/, '')
  if (win !== voice || win.includes(' ')) {
    const name = win.replace(/^Microsoft /, '').replace(/ (Native|Desktop)$/, '')
    return isLong ? `${name} (Windows)` : name
  }
  const name = voice.replace(/^[a-z]{2}_/, '')
  return isLong ? `${name} (Kokoro ${KOKORO_NAMES[voice.slice(0, 2)] ?? ''})`.replace(' )', ')') : name
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
const plain = (text: string) => text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*|__|`/g, '')

/**
 * The message while one of its sentences is heard, drawn by the mod: the
 * lines before and after stay markdown, and the line being read is text with
 * the sentence on a highlight. Markdown has no background colour, so this is
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
  const hl = str('highlightColor', '#f1fa8c')
  const fg = str('highlightTextColor', '#282a36')

  return (
    <Box flexDirection="row">
      <Text>{lead}</Text>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {before ? [<Markdown text={before} />] : []}
        <Box marginTop={before ? gapBefore : 0}>
          <Text bold={heading !== null}>
            {prefix}
            {pre}
            <Text backgroundColor={hl} color={fg}>
              {span}
            </Text>
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

/** The buttons every message carries, and its progress while it's read. */
/**
 * What a message carries besides its text: \`below\`, a row under it (the
 * progress while it's read, with \`controls: message\`; the buttons, with
 * \`buttons: always\`), and \`gutter\`, a dim ♪ in a narrow column at its right
 * that shows the buttons while the pointer is on it (\`buttons: hover\`). The
 * hover is the ♪ alone, not the whole message: a pointer resting over the
 * transcript otherwise lit each message that scrolled under it as a message
 * was sent, so buttons flashed up and away.
 */
type MessageExtras = { below: RenderElement | null; gutter: RenderElement | null; overlay: RenderElement | null }

async function messageRow($: $, e: MessageEvent, text: string, key: string, label: string): Promise<MessageExtras> {
  const { Box, Text, Button } = $.ui.resolve(e)
  const s = await settings($)
  const at = await read($, cursor)
  const id = e.requestId
  const isThis = at !== null && at.key === key
  const status = isThis ? await read($, now) : null // only the message being read follows the clock
  const isPlaying = status !== null && (status.state === 'playing' || status.state === 'loading')

  const controls = (
    <Box key={`${id}-controls`} columnGap={1}>
      <Button key={`${id}-play`} label={isPlaying ? '‖' : '▶'} onPress={() => (isThis ? control($, 'toggle') : speak($, text, key, label, 'now'))} />
      <Button key={`${id}-restart`} label="⟲" onPress={() => (isThis ? control($, 'restart') : speak($, text, key, label, 'now'))} />
      {isThis ? [<Button key={`${id}-stop`} label="■" onPress={() => control($, 'stop')} />] : []}
      <Button key={`${id}-slower`} label="−" onPress={() => setSpeed($, s.speed - SPEED_STEP)} />
      <Text dimColor>{s.speed}×</Text>
      <Button key={`${id}-faster`} label="+" onPress={() => setSpeed($, s.speed + SPEED_STEP)} />
      <Button key={`${id}-voice`} label={voiceName(s.voice)} onPress={() => nextVoice($)} />
    </Box>
  )

  // `hover`: the buttons over the message's top-right corner while the pointer
  // is anywhere on the message. They can flash as messages scroll under a
  // resting pointer; `glyph` avoids that by hovering a ♪ alone.
  const overlay =
    buttons() === 'hover' ? (
      <Box position="absolute" top={0} right={0} display="none" hover={{ display: 'flex' }} backgroundColor="black">
        {controls}
      </Box>
    ) : null
  const gutter =
    buttons() === 'glyph' ? (
      <Box key={`ra-${id}-gutter`} width={2} flexShrink={0}>
        <Text color={isThis ? 'cyan' : undefined} dimColor={!isThis}>
          {' ♪'}
        </Text>
        <Box position="absolute" top={0} right={2} display="none" hover={{ display: 'flex' }} backgroundColor="black">
          {controls}
        </Box>
      </Box>
    ) : null

  if (status !== null && controlsAt() !== 'bottom') {
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
  return { below: buttons() === 'always' ? controls : null, gutter, overlay }
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
            {voiceName(s.voice)}
          </Text>
          <Text dimColor>
            {'  '}
            {s.speed}× · {auto}
          </Text>
        </Text>
        <Button key="last" hotkey="r" label="▶ last reply" onPress={() => readLast($)} />
        <Button key="settings" hotkey="o" label="settings" onPress={() => $.ui.open({ id: PANE, title: 'Read aloud' })} />
      </Box>
    )
  }

  const isPaused = status.state === 'paused'
  const fraction = status.total ? (status.position ?? 0) / status.total : 0
  const where = status.sentences ? ` ${(status.sentence ?? 0) + 1}/${status.sentences}` : ''
  const queued = status.queue ? ` +${status.queue}` : ''
  const voice = voiceName(status.voice ?? s.voice)
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
        <Button key="toggle" hotkey="p" label={isPaused ? '▶' : '‖'} onPress={() => control($, 'toggle')} />
        <Button key="stop" hotkey="s" label="■" onPress={() => control($, 'stop')} />
        <Button key="back" hotkey="b" label="«" onPress={() => control($, 'back')} />
        <Button key="forward" hotkey="n" label="»" onPress={() => control($, status.queue ? 'skip' : 'forward')} />
        <Button key="slower" label="−" onPress={() => setSpeed($, s.speed - SPEED_STEP)} />
        <Button key="faster" label="+" onPress={() => setSpeed($, s.speed + SPEED_STEP)} />
      </Box>
    </Box>
  )
}

export const register: Register = (on, options) => {
  opt = options as Options

  // ------------------------------------------------------------ events

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'read-aloud',
      description: 'Read aloud: open its settings, or stop | pause | read | speed N | voice NAME | auto replies off|final|all | auto mine on|off | save',
      argumentHint: '[stop|pause|read|speed N|voice NAME|auto …|save]',
    })
    ticker?.cancel()
    ticker = $.clock.every(400, () => tick($))
    // Load the voices' Kokoro pipelines now, so the first read starts at once.
    void (async () => {
      try {
        const s = await settings($)
        await call($, '/warm', { voices: [s.voice, s.jaVoice, s.heVoice] })
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
  }).catch(($, e, next) => next(e)) // reading aloud never holds up a prompt

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && e.reason === 'answer' && (await settings($)).autoReadReplies === 'final') {
      await speak($, e.answer, messageKey('a', e.answer), 'reply', 'queue')
    }
    return done
  })

  // `all`: read each model step's visible text as the step ends, the short
  // updates written just before a tool call included. Those never reach the
  // transcript as their own rows, so listening to session.append missed them.
  on('turn.step', async function* ($, e, next) {
    const step = yield* next(e)
    if (e.agentId === undefined && step.answer.trim() && (await settings($)).autoReadReplies === 'all') {
      await speak($, step.answer, messageKey('a', step.answer), 'reply', 'queue')
    }
    return step
  })

  on('command.run', { command: 'read-aloud' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    const arg = rest.join(' ')
    switch (verb) {
      case '':
      case 'settings':
        await $.ui.open({ id: PANE, title: 'Read aloud' })
        return { text: 'Read-aloud settings opened.' }
      case 'stop':
      case 'pause':
        await control($, verb === 'stop' ? 'stop' : 'toggle')
        return { text: verb === 'stop' ? 'Stopped.' : 'Paused or resumed.' }
      case 'read':
        return { text: (await readLast($)) ? 'Reading the last reply.' : 'No reply to read yet.' }
      case 'speed': {
        const speed = Number(arg)
        if (!Number.isFinite(speed) || speed <= 0) return { text: 'Usage: /read-aloud speed 2.5' }
        await setSpeed($, speed)
        return { text: `Speed ${(await settings($)).speed}×.` }
      }
      case 'voice': {
        // voice NAME sets English; voice ja NAME / voice he NAME set the others.
        const [first = '', ...more] = rest
        const lang: Lang = first === 'ja' || first === 'he' || first === 'en' ? first : 'en'
        const voice = (lang === first ? more.join(' ') : arg).trim()
        if (!voice) return { text: 'Usage: /read-aloud voice am_fenrir, voice ja jf_alpha, voice he win:Microsoft Hila Native' }
        await setVoice($, lang, voice)
        return { text: `${LANGS.find(l => l.lang === lang)?.name} voice: ${voiceName(voice, true)}.` }
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
        return { text: 'Usage: /read-aloud auto replies off|final|all, or auto mine on|off' }
      }
      case 'save':
        return { text: await saveDefaults($) }
      default:
        return { text: `Unknown: ${verb}. Try stop, pause, read, speed N, voice NAME, auto …, save.` }
    }
  })

  // ------------------------------------------------------------ drawing

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary || !e.props.text.trim()) return next(e)
    const key = messageKey('a', e.props.text)
    const inner = await drawMessage($, e, e.props.text, key, e.props.isFirstOfReply ? '● ' : '  ', ev => next(ev as typeof e))
    return wrap($, e, inner, await messageRow($, e, e.props.text, key, 'reply'))
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const kind = e.props.origin.kind
    if ((kind !== 'composer' && kind !== 'bridge') || !e.props.text.trim()) return next(e)
    const key = messageKey('u', e.props.text)
    const inner = await drawMessage($, e, e.props.text, key, '❯ ', ev => next(ev as typeof e))
    return wrap($, e, inner, await messageRow($, e, e.props.text, key, 'your message'))
  })

  // The player at the bottom: one row that is always there, idle or reading,
  // so it never pushes the transcript when a read starts or ends. With
  // `bottom: hint` it is a dim tail on the hint line under the prompt instead.
  // Other mods draw here too (token-weather, blast-radius): their band stays,
  // under the player's row, rather than the player hiding it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || controlsAt() === 'message' || str('bottom', 'band') !== 'band') return next(e)
    const others = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    // A dim rule, like the one over the prompt, parts the band from the chat.
    const cols = e.props.bodyColumns ?? e.viewport?.columns ?? 80
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">
          {'─'.repeat(Math.max(1, cols))}
        </Text>
        {await playerRow($, e)}
        {others}
      </Box>
    )
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (controlsAt() === 'message' || str('bottom', 'band') !== 'hint') return next(e)
    const status = await read($, now)
    if (status === null) return next(e)
    const s = await settings($)
    const mark = icon(stateOf(status))
    const tail = `${mark} ${clock(status.position)}/${clock(status.total)} · ${status.speed ?? s.speed}× ${voiceName(status.voice ?? s.voice)}`
    return next({ ...e, props: { ...e.props, tail } })
  })

  // /read-aloud with no arguments: the settings, one place for all of them.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await settings($)
    const status = await read($, now)
    const pick = (isOn: boolean) => (isOn ? ('primary' as const) : undefined)
    return (
      <Box flexDirection="column" rowGap={1}>
        <Text dimColor>
          {status ? `${status.state} · ${status.label ?? ''} · ${clock(status.position)} of ${clock(status.total)}` : 'Not reading.'}
        </Text>
        {LANGS.map(({ lang, name, field, list: voices }) => (
          <Box key={`lang-${lang}`} flexDirection="column">
            <Text bold>{name} voice</Text>
            <Box columnGap={1} flexWrap="wrap">
              {s[voices].map(v => (
                <Button key={`${lang}-${v}`} label={voiceName(v, true)} variant={pick(v === s[field])} onPress={() => setVoice($, lang, v)} />
              ))}
            </Box>
          </Box>
        ))}
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
        <Box columnGap={1}>
          <Text bold>Lower other apps while reading</Text>
          {DUCK_LEVELS.map(v => (
            <Button key={`duck-${v}`} label={v === 'off' ? 'off' : `to ${v}`} variant={pick(s.duckOthers === v)} onPress={() => setDuck($, v)} />
          ))}
        </Box>
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
          <Button key="save" variant="primary" label="save as defaults" onPress={async () => $.ui.toast(await saveDefaults($))} />
          <Button key="read-last" label="▶ read last reply" onPress={() => readLast($)} />
          <Button key="stop" label="■ stop" onPress={() => control($, 'stop')} />
        </Box>
        <Box columnGap={1}>
          <Text bold>Controls while reading</Text>
          {['bottom', 'message', 'both'].map(v => (
            <Button key={`controls-${v}`} label={v} variant={pick(controlsAt() === v)} onPress={() => $.config.set({ key: 'read-aloud.controls', value: v })} />
          ))}
        </Box>
        <Box columnGap={1}>
          <Text bold>Bottom player</Text>
          {(['band', 'hint'] as const).map(v => (
            <Button key={`bottom-${v}`} label={v} variant={pick(str('bottom', 'band') === v)} onPress={() => $.config.set({ key: 'read-aloud.bottom', value: v })} />
          ))}
        </Box>
        <Text dimColor>The message buttons switch the English voice. Lists and defaults are in /config under read-aloud; the two rows above save at once.</Text>
      </Box>
    )
  })
}
