import type { Register } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { formatVoices, highlightProps, parseVoices, voiceName } from '../hooks/register'

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
