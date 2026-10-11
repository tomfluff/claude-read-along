import { expect, test } from 'claude-code/testing'

const REPLY = { text: 'The tmux server survived the forced kill.', isFirstOfReply: true }

test('a reply carries play, speed and voice buttons on every surface', async ($, on) => {
  on('ui.render', () => ({ type: 'engine', ref: 0 })) // the engine's own drawing, beneath the plugin
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'read-aloud', surface, component: 'AssistantMessage', props: REPLY, requestId: 'm1' })
    expect(await ui.find({ key: 'm1-play' })).toBeDefined()
    expect(await ui.find({ key: 'm1-faster' })).toBeDefined()
    expect((await ui.find({ key: 'm1-voice' }))?.text).toContain('heart')
  }
})

test('the faster button raises the speed by a quarter', async ($, on) => {
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  const ui = await $.ui.mount({ plugin: 'read-aloud', surface: 'terminal', component: 'AssistantMessage', props: REPLY, requestId: 'm2' })
  expect(await ui.find({ text: '2.5×' })).toBeDefined()
  await ui.press({ key: 'm2-faster' })
  expect(await ui.find({ text: '2.75×' })).toBeDefined()
})

test('the band carries no playback controls while nothing is read', async ($, on) => {
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  const ui = await $.ui.mount({ plugin: 'read-aloud', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  expect(await ui.find({ key: 'stop' })).toBeUndefined()
})

test('a left-out child leaves no row behind', async ($, on) => {
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  const ui = await $.ui.mount({ plugin: 'read-aloud', surface: 'terminal', component: 'AssistantMessage', props: REPLY, requestId: 'm3' })
  expect(JSON.stringify(await ui.drawn())).not.toContain('false')
})

test('the bottom player is one row even while idle, so nothing jumps', async ($, on) => {
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  const props = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } as never
  const ui = await $.ui.mount({ plugin: 'read-aloud', surface: 'terminal', component: 'AbovePrompt', props })
  expect(await ui.find({ key: 'last' })).toBeDefined()
  expect(await ui.find({ key: 'settings' })).toBeDefined()
  // The player first, other mods' band under it: one row, not a column of rows.
  const tree = (await ui.drawn()) as { children?: { props?: { flexDirection?: string } }[] }
  const player = tree.children?.[0]
  expect(player?.props?.flexDirection).toBeUndefined()
})
