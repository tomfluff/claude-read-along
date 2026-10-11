import { expect, test } from 'claude-code/testing'

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
  // A rule, then the player, then other mods' band: the player is one row.
  const tree = (await ui.drawn()) as { children?: { props?: { flexDirection?: string } }[] }
  const player = tree.children?.[1]
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
