import type { Register } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { factoryDefaults, formatVoices, highlightProps, inlineRuns, layoutTable, markSentence, messageKey, parseVoices, splitAfter, voiceLabel, voiceName, voiceRows } from '../hooks/register'

const REPLY = { text: 'The tmux server survived the forced kill.', isFirstOfReply: true }

test('a reply carries play, speed and voice buttons on every surface', async ($, on) => {
  on('ui.render', () => ({ type: 'engine', ref: 0 })) // the engine's own drawing, beneath the plugin
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'read-along', surface, component: 'AssistantMessage', props: REPLY, requestId: 'm1' })
    expect(await ui.find({ key: 'm1-play' })).toBeDefined()
    expect(await ui.find({ key: 'm1-faster' })).toBeDefined()
    expect((await ui.find({ key: 'm1-voice' }))?.text).toContain('auto')
  }
})

test('on the phone the buttons show without a pointer to hover with', async ($, on) => {
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  const hidden = async (surface: 'terminal' | 'mobile', id: string) => {
    const ui = await $.ui.mount({ plugin: 'read-along', surface, component: 'AssistantMessage', props: REPLY, requestId: id })
    expect(await ui.find({ key: `${id}-play` })).toBeDefined()
    return JSON.stringify(await ui.drawn()).includes('"display":"none"')
  }
  expect(await hidden('terminal', 'm5')).toBe(true)
  expect(await hidden('mobile', 'm6')).toBe(false)
})

test('the voice button names the chosen main voice', { options: { voices: 'main=kokoro:af_heart, win:Microsoft Aria Native; ja=kokoro:jf_alpha' } }, async ($, on) => {
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  const ui = await $.ui.mount({ plugin: 'read-along', surface: 'terminal', component: 'AssistantMessage', props: REPLY, requestId: 'm4' })
  expect((await ui.find({ key: 'm4-voice' }))?.text).toContain('heart')
})

test('the faster button raises the speed by a quarter', async ($, on) => {
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  const ui = await $.ui.mount({ plugin: 'read-along', surface: 'terminal', component: 'AssistantMessage', props: REPLY, requestId: 'm2' })
  expect(await ui.find({ text: '1.25×' })).toBeDefined()
  await ui.press({ key: 'm2-faster' })
  expect(await ui.find({ text: '1.5×' })).toBeDefined()
})

test('the band carries no playback controls while nothing is read', async ($, on) => {
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  const ui = await $.ui.mount({ plugin: 'read-along', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  expect(await ui.find({ key: 'stop' })).toBeUndefined()
})

test('a left-out child leaves no row behind', async ($, on) => {
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  const ui = await $.ui.mount({ plugin: 'read-along', surface: 'terminal', component: 'AssistantMessage', props: REPLY, requestId: 'm3' })
  expect(JSON.stringify(await ui.drawn())).not.toContain('false')
})

test('the bottom player is one row even while idle, so nothing jumps', async ($, on) => {
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  const props = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } as never
  const ui = await $.ui.mount({ plugin: 'read-along', surface: 'terminal', component: 'AbovePrompt', props })
  expect(await ui.find({ key: 'last' })).toBeDefined()
  expect(await ui.find({ key: 'settings' })).toBeDefined()
  // The player, then other mods' band: the player is one row.
  const tree = (await ui.drawn()) as { children?: { props?: { flexDirection?: string } }[] }
  const player = tree.children?.[0]
  expect(player?.props?.flexDirection).toBeUndefined()
})

test('player: message leaves the prompt band to the engine', { options: { player: 'message' } }, async ($, on) => {
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  const props = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } as never
  const ui = await $.ui.mount({ plugin: 'read-along', surface: 'terminal', component: 'AbovePrompt', props })
  expect(await ui.find({ key: 'last' })).toBeUndefined()
})

test('the settings pane hides lowering other apps where the machine cannot', async ($, on) => {
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  const ui = await $.ui.mount({ plugin: 'read-along', surface: 'terminal', component: 'Pane', props: {} as never, requestId: 'read-along' })
  expect(await ui.find({ key: 'main-auto' })).toBeDefined()
  expect(await ui.find({ key: 'duck-off' })).toBeUndefined()
  expect(await ui.find({ key: 'add-ja' })).toBeDefined()
})

test('the voices setting reads per group, main by default', async () => {
  expect(parseVoices('auto')).toEqual({ main: ['auto'] })
  expect(parseVoices('kokoro:af_heart, mac:Samantha')).toEqual({ main: ['kokoro:af_heart', 'mac:Samantha'] })
  const lists = parseVoices('main=kokoro:af_heart, win:Microsoft Aria Native; ja = kokoro:jf_alpha')
  expect(lists).toEqual({ main: ['kokoro:af_heart', 'win:Microsoft Aria Native'], ja: ['kokoro:jf_alpha'] })
  expect(parseVoices(formatVoices(lists))).toEqual(lists)
  expect(parseVoices('ja=kokoro:jf_alpha')).toEqual({ ja: ['kokoro:jf_alpha'], main: ['auto'] })
})

test('voice names are short, with the engine when long', async () => {
  expect(voiceName('kokoro:af_heart')).toBe('heart')
  expect(voiceName('kokoro:bf_emma', true)).toBe('emma (Kokoro UK)')
  expect(voiceName('win:Microsoft Aria Native')).toBe('Aria')
  expect(voiceName('win:Microsoft Zira Desktop', true)).toBe('Zira (Windows)')
  expect(voiceName('mac:Samantha', true)).toBe('Samantha (macOS)')
  expect(voiceName('espeak:en-us', true)).toBe('en-us (eSpeak)')
  expect(voiceName('pocket:self-warm_conversational', true)).toBe('self-warm_conversational (Pocket TTS)')
  expect(voiceName('auto')).toBe('auto')
  // Names from before engines were named.
  expect(voiceName('af_heart')).toBe('heart')
  expect(voiceName('Microsoft Hila Native')).toBe('Hila')
})

test('the highlight is reverse video unless a colour is given', async () => {
  expect(highlightProps('reverse')).toEqual({ inverse: true })
  expect(highlightProps('')).toEqual({ inverse: true })
  expect(highlightProps('yellow')).toEqual({ backgroundColor: 'yellow' })
  expect(highlightProps('#7d1010/#ffffff')).toEqual({ backgroundColor: '#7d1010', color: '#ffffff' })
})

test('auto-read reads a step\'s text when its block ends, before the tool call has streamed', { options: { autoReadReplies: 'all' } }, async ($, on) => {
  const spoken: string[] = []
  const toasts: string[] = []
  let toolStreamed = false
  on('ui.toast', async ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  mock.env(on, { USER: 'tester' })
  on('process.run', async () => ({ value: { exitCode: 0, stdout: 'ok', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('http.fetch', async ($, e) => {
    if (e.url.endsWith('/speak')) spoken.push(`${JSON.parse(String(e.init?.body)).text}${toolStreamed ? ' (late)' : ''}`)
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ state: 'idle', queue: 0 }) } }
  })
  on('turn.step', async function* () {
    yield { kind: 'text', index: 0, text: 'Checking the logs ' }
    yield { kind: 'text', index: 0, text: 'first.' }
    yield { kind: 'tool', index: 1, id: 't1', name: 'Bash' }
    toolStreamed = true
    yield { kind: 'input', index: 1, json: '{"command":"ls"}' }
    yield { kind: 'stop', stopReason: 'tool_use', usage: null }
    return { turnId: 'turn', index: 0, answer: 'Checking the logs first.', toolUses: [], stopReason: 'tool_use', usage: null }
  })
  for await (const _ of $.turn.step({ turnId: 'turn', index: 0, model: 'm', messageCount: 1 })) {
    // drain the stream as the engine does
  }
  expect(toasts).toEqual([])
  expect(spoken).toEqual(['Checking the logs first.'])
})

// A mod listed before read-along that draws its own band and stops there.
const bandHog = {
  name: 'band-hog',
  tier: 'prepend' as const,
  register: ((on) => {
    on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>hog</Text>
    })
  }) satisfies Register,
}

test('a mod that hides the band is noticed, once a session', { plugins: [bandHog] }, async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { USER: 'tester' })
  const toasts: string[] = []
  on('ui.toast', async ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('process.run', async () => ({ value: { exitCode: 0, stdout: 'doctor ok', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ state: 'idle', queue: 0 }) } }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('command.register', async ($, e) => ({ value: { command: e.name } }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.ui.mount({ plugin: 'read-along', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } as never })
  await $.ui.mount({ plugin: 'read-along', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } as never })
  await clock.advance(3500)
  await clock.advance(2000)
  expect(toasts.filter(t => t.includes('another mod hides the player')).length).toBe(1)
})

test('a band passed on is not reported, and the check redraws no message', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { USER: 'tester' })
  const toasts: string[] = []
  on('ui.toast', async ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('process.run', async () => ({ value: { exitCode: 0, stdout: 'ok', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ state: 'idle', queue: 0 }) } }))
  let messageDraws = 0
  on('ui.render', (_, e) => {
    if (e.component === 'AssistantMessage') messageDraws += 1
    return { type: 'engine', ref: 0 }
  })
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('command.register', async ($, e) => ({ value: { command: e.name } }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.ui.mount({ plugin: 'read-along', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } as never })
  await $.ui.mount({ plugin: 'read-along', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } as never })
  await $.ui.mount({ plugin: 'read-along', surface: 'terminal', component: 'AssistantMessage', props: REPLY, requestId: 'm9' })
  const before = messageDraws
  await clock.advance(3500)
  await clock.advance(2000)
  expect(toasts).toEqual([])
  expect(messageDraws).toBe(before)
})

for (const readThinking of [true, false]) {
  test(`thinking shown as an update is read only with readThinking (${readThinking ? 'on' : 'off'})`, { options: { autoReadReplies: 'all', readThinking } }, async ($, on) => {
    const spoken: string[] = []
    mock.env(on, { USER: 'tester' })
    on('process.run', async () => ({ value: { exitCode: 0, stdout: 'ok', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('http.fetch', async ($, e) => {
      if (e.url.endsWith('/speak')) spoken.push(JSON.parse(String(e.init?.body)).text)
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ state: 'idle', queue: 0 }) } }
    })
    on('turn.step', async function* () {
      yield { kind: 'thinking', index: 0, text: "I'll check the reference links " }
      yield { kind: 'thinking', index: 0, text: 'first.' }
      yield { kind: 'tool', index: 1, id: 't1', name: 'Bash' }
      yield { kind: 'stop', stopReason: 'tool_use', usage: null }
      return { turnId: 'turn', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', usage: null }
    })
    for await (const _ of $.turn.step({ turnId: 'turn', index: 0, model: 'm', messageCount: 1 })) {
      // drain the stream as the engine does
    }
    expect(spoken).toEqual(readThinking ? ["I'll check the reference links first."] : [])
  })
}

test('the line being read keeps bold, italics, links and strikethrough, in one colour', async () => {
  const raw = 'Use **bold** and _it_ with [a link](https://x.y) and `code`, ~~gone~~. Next one 🎉 here.'
  const read = { start: 0, end: raw.indexOf('Next') - 1 }
  const runs = inlineRuns(raw, 0, raw.length, read)
  const text = runs.map(r => r.text).join('')
  expect(text).toBe('Use bold and it with a link and code, gone. Next one 🎉 here.')
  const styleOf = (t: string) => runs.find(r => r.text.includes(t))?.style
  expect(styleOf('bold')).toEqual({ bold: true })
  expect(styleOf('it ')).toBeUndefined() // "it" is its own run
  expect(runs.find(r => r.text === 'it')?.style).toEqual({ italic: true })
  expect(styleOf('a link')).toEqual({ underline: true })
  expect(styleOf('gone')).toEqual({ strikethrough: true })
  expect(styleOf('code')).toEqual({}) // inline code: backticks gone, no colour
  // The highlight covers the first sentence only.
  expect(runs.filter(r => r.isRead).map(r => r.text).join('')).toBe('Use bold and it with a link and code, gone.')
  expect(runs.filter(r => !r.isRead).map(r => r.text).join('')).toBe(' Next one 🎉 here.')
  // snake_case stays as written; a sentence after an emoji is still found.
  expect(inlineRuns('call read_along_now', 0, 19, { start: 0, end: 0 }).map(r => r.text).join('')).toBe('call read_along_now')
  const emoji = '🎉 Done. Then more.'
  const after = inlineRuns(emoji, 0, emoji.length, { start: emoji.indexOf('Then'), end: emoji.length })
  expect(after.filter(r => r.isRead).map(r => r.text).join('')).toBe('Then more.')
})

test('a bare web address becomes its own link run, without trailing punctuation', async () => {
  const raw = 'See https://sechayk.com/claude-read-along/. Then <https://x.y/z> too.'
  const runs = inlineRuns(raw, 0, raw.length, { start: 0, end: raw.length })
  expect(runs.filter(r => r.href).map(r => [r.text, r.href])).toEqual([
    ['https://sechayk.com/claude-read-along/', 'https://sechayk.com/claude-read-along/'],
    ['https://x.y/z', 'https://x.y/z'],
  ])
  expect(runs.map(r => r.text).join('')).toBe('See https://sechayk.com/claude-read-along/. Then https://x.y/z too.')
})

test('a table row being read gets its cells in bold', async () => {
  const raw = 'Voices:\n\n| Voice | Language |\n|---|---|\n| heart | English |\n| alpha | Japanese |'
  expect(markSentence(raw, 'heart, English.')).toBe('Voices:\n\n| Voice | Language |\n|---|---|\n| **heart** | **English** |\n| alpha | Japanese |')
  expect(markSentence(raw, 'Voice, Language.')).toContain('| **Voice** | **Language** |')
})

test('a table lays out with its widths, alignments and the row being read', async () => {
  const lines = ['| Voice | Language | Speed |', '|:--|:-:|--:|', '| **heart** | English | 1.5 |', '| alpha | 日本語 | 2 |']
  const t = layoutTable(lines, 3)
  expect(t?.widths).toEqual([5, 8, 5]) // 日本語 takes six cells
  expect(t?.aligns).toEqual(['left', 'center', 'right'])
  expect(t?.rows.map(r => [r.isHeader, r.isRead])).toEqual([[true, false], [false, false], [false, true]])
  expect(t?.rows[1]?.cells[0]).toEqual([{ text: 'heart', style: { bold: true }, isRead: false }])
  expect(layoutTable(['| a | b |', '| c | d |'], 1)).toBeUndefined() // no separator row: not a table
})

test('a table row being read is drawn as a whole table, a rule between rows, the row on the highlight', { options: { highlight: '#7d1010/#ffffff' } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { USER: 'tester' })
  const reply = 'The voices:\n\n| Voice | Language |\n|---|---|\n| heart | English |\n| alpha | Japanese |\n\nThat is all.'
  on('process.run', async () => ({ value: { exitCode: 0, stdout: 'ok', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('http.fetch', async ($, e) => {
    const status = e.url.endsWith('/status') ? { state: 'playing', key: messageKey('a', reply), label: 'reply', text: 'heart, English.', sentence: 1, sentences: 3, queue: 0 } : { state: 'idle', queue: 0 }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(status) } }
  })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('command.register', async ($, e) => ({ value: { command: e.name } }))
  on('ui.status', async () => ({ value: undefined }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.advance(3300) // the clock's idle check asks the service, which is reading the row
  const ui = await $.ui.mount({ plugin: 'read-along', surface: 'terminal', component: 'AssistantMessage', props: { text: reply, isFirstOfReply: true }, requestId: 't1' })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('┌───────┬──────────┐')
  expect(drawn).toContain('├───────┼──────────┤')
  expect(drawn).toContain('{"backgroundColor":"#7d1010","color":"#ffffff"},"children":["heart"]') // the background, not bold
  expect(drawn.split('├───────┼──────────┤').length - 1).toBe(2) // under the header and between the two rows
  expect(drawn).toContain('That is all.')
})

test('the lines after the one being read keep their indent', async () => {
  // Reading "b": "c" sits deeper, "d" back at b's level, "e" at the edge.
  const t = splitAfter('\n    - c\n      more of c\n  - d\n\n- e\n- f')
  expect(t.parts).toEqual([
    { indent: 4, text: '- c\n  more of c', gap: 0 },
    { indent: 2, text: '- d', gap: 0 },
  ])
  expect(t.rest).toBe('- e\n- f')
  expect(t.restGap).toBe(1)
  expect(splitAfter('\n\nNext paragraph.')).toEqual({ parts: [], rest: 'Next paragraph.', restGap: 1 })
  expect(splitAfter('')).toEqual({ parts: [], rest: '', restGap: 0 })
  // A blank line inside an item stays with it when deeper lines follow.
  expect(splitAfter('\n  - x\n\n    still x\n- y').parts).toEqual([{ indent: 2, text: '- x\n\n  still x', gap: 0 }])
})

test('a nested list item being read leaves the deeper item under it indented', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { USER: 'tester' })
  const reply = '- a\n  - b is read.\n    - c stays deeper.\n- d'
  on('process.run', async () => ({ value: { exitCode: 0, stdout: 'ok', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('http.fetch', async ($, e) => {
    const status = e.url.endsWith('/status') ? { state: 'playing', key: messageKey('a', reply), label: 'reply', text: 'b is read.', sentence: 1, sentences: 4, queue: 0 } : { state: 'idle', queue: 0 }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(status) } }
  })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('command.register', async ($, e) => ({ value: { command: e.name } }))
  on('ui.status', async () => ({ value: undefined }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.advance(3300)
  const ui = await $.ui.mount({ plugin: 'read-along', surface: 'terminal', component: 'AssistantMessage', props: { text: reply, isFirstOfReply: true }, requestId: 't1' })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('"paddingLeft":4')
  expect(drawn).toContain('- c stays deeper.')
  expect(drawn).toContain('"text":"- d"')
})

test('the settings list voices in rows by engine, your own Pocket TTS voices first', async () => {
  expect(voiceLabel('kokoro:bf_emma')).toBe('emma (UK)')
  expect(voiceLabel('pocket:alba')).toBe('alba')
  expect(voiceLabel('win:Microsoft Zira Desktop')).toBe('Zira')
  const v = (id: string, engine: string, own?: boolean) => ({ id, name: id, lang: 'en', engine, ...(own ? { own } : {}) })
  const rows = voiceRows([v('kokoro:af_heart', 'kokoro'), v('pocket:alba', 'pocket'), v('pocket:me', 'pocket', true), v('kokoro:bf_emma', 'kokoro')])
  expect(rows.map(([label, list]) => [label, list.map(x => x.id)])).toEqual([
    ['Your voices', ['pocket:me']],
    ['Kokoro', ['kokoro:af_heart', 'kokoro:bf_emma']],
    ['Pocket TTS', ['pocket:alba']],
  ])
})

test("the plugin's own defaults come from its manifest's userConfig", async () => {
  const manifest = JSON.stringify({
    name: 'read-along',
    userConfig: { speed: { type: 'number', default: 1.25 }, readCode: { type: 'boolean', default: false }, voices: { type: 'string', default: 'auto' }, other: { type: 'string' } },
  })
  expect(factoryDefaults(manifest)).toEqual([
    ['speed', 1.25],
    ['readCode', false],
    ['voices', 'auto'],
  ])
  expect(factoryDefaults('{}')).toEqual([])
})

const paneSetup = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1]) => {
  mock.env(on, { USER: 'tester' })
  on('process.run', async () => ({ value: { exitCode: 0, stdout: 'ok', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ state: 'idle', queue: 0 }) } }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('command.register', async ($, e) => ({ value: { command: e.name } }))
  on('ui.status', async () => ({ value: undefined }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'read-along', surface: 'terminal', component: 'Pane', props: { title: 'Read-along', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }, requestId: 'read-along' })
  return JSON.stringify(await ui.drawn())
}

test('by default the settings show the main voice alone, the other languages a click away', async ($, on) => {
  const drawn = await paneSetup($, on)
  expect(drawn).not.toContain('Japanese voice')
  expect(drawn).toContain('"label":"Japanese"') // under Other languages
  expect(drawn).toContain('"label":"Hebrew"')
  // The actions sit under the player choice: read and stop, then save and reset.
  const at = (label: string) => drawn.indexOf(`"label":"${label}"`)
  expect(at('band+message')).toBeLessThan(at('▶ read last reply'))
  expect(at('■ stop')).toBeLessThan(at('save as defaults'))
  expect(at('save as defaults')).toBeLessThan(at('reset…'))
})

test('saved voices for a language keep it shown in the settings', { options: { voices: 'main=auto; ja=kokoro:jf_alpha; he=win:Microsoft Hila Native' } }, async ($, on) => {
  const drawn = await paneSetup($, on)
  expect(drawn).toContain('Japanese voice')
  expect(drawn).toContain('Hebrew voice')
})
