import { expect, test } from 'claude-code/testing'

import { argvFor } from '../hooks/external'

const ID = 'local_11111111-2222-3333-4444-555555555555'
const PANE = {
  plugin: 'threads',
  component: 'Pane',
  requestId: 'threads',
  props: {
    title: 'Threads',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('a started session shows in the pane with its model', async ($, on) => {
  const sent: string[] = []
  on('command.register', () => ({ value: { command: 'threads' } }))
  on('tool.register', (_, e) => ({ value: { tool: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', (_, e) => {
    const input = e as unknown as Record<string, unknown>
    if (e.tool === 'mcp__ccd_session__start_session') return { result: {}, text: `Started ${ID}` }
    if (e.tool === 'mcp__ccd_session_mgmt__send_message') {
      sent.push(String(input.message))
      return { result: {}, text: 'delivered' }
    }
    return { result: {}, text: '{}' }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__ccd_session__start_session',
    initiation: 'user_asked',
    name: 'demo',
    title: 'Demo thread',
    model: 'claude-haiku-5-5',
    effort: 'low',
    prompt: 'List files',
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /demo/ }))?.text).toBe('working · demo · claude')
    expect((await ui.find({ type: 'Text', text: /haiku/ }))?.text).toMatch(/haiku-5-5 · effort low/)
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `status-${ID}` })
  expect(sent[0]).toMatch(/status/)
  await ui.unmount()
})

test('a Codex review run is tracked and is read-only on Astra', async ($, on) => {
  const ran: string[][] = []
  const written: string[] = []
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    const stdout = e.argv[0] === 'printenv' ? '/Users/test\n' : '/work\n'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.write', (_, e) => {
    written.push(`${e.path}\n${e.text}`)
    return { value: undefined }
  })
  const watchers: Record<string, unknown>[] = []
  on('tool.call', (_, e) => {
    watchers.push(e as unknown as Record<string, unknown>)
    return { result: {}, text: 'Started session (session_id: local_99999999-2222-3333-4444-555555555555, name: w-astra-review)' }
  })
  on('command.register', () => ({ value: { command: 'threads' } }))
  on('tool.register', (_, e) => ({ value: { tool: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const res = await $.tool.call({
    tool: 'mcp__threads__run_external',
    vendor: 'codex',
    role: 'review',
    name: 'astra-review',
    prompt: 'Review hooks/register.tsx',
  } as never)
  const started = String(res.result ?? res.text)
  expect(started).toMatch(/Started codex thread "astra-review"/)
  // The lead gets the watcher's arguments and starts it with its own call.
  expect(started).toMatch(/"name": "w-astra-review"/)
  expect(started).toMatch(/"model": "claude-haiku-5-5"/)
  await $.tool.call({
    tool: 'mcp__ccd_session__start_session',
    initiation: 'user_asked',
    name: 'w-astra-review',
    prompt: 'watch',
  } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /· astra-review/ }))?.text).toBe('working · astra-review · codex review')
  expect((await ui.find({ type: 'Text', text: /Sidebar/ }))?.text).toBe('Sidebar: w-astra-review')
  await ui.unmount()

  // Detached: a run.sh under ~/.claude/mcp/threads-runs/<id>/ started with nohup, writing exit at the end.
  expect(written[0]).toMatch(/^\/Users\/test\/\.claude\/mcp\/threads-runs\/codex_[0-9a-f]{8}\/run\.sh/)
  expect(written[0]).toMatch(/'codex' 'exec' '-m' 'gpt-6-astra'/)
  expect(written[0]).toMatch(/echo \$\? > /)
  expect(ran.some(argv => argv[2]?.startsWith('nohup /bin/sh'))).toBe(true)
  expect(watchers.some(w => w.name === 'w-astra-review')).toBe(true)
  expect(written.some(w => w.includes('/watch.sh\n') && w.includes('echo RESULT'))).toBe(true)

  const argv = argvFor({ vendor: 'codex', role: 'review', name: 'r', prompt: 'x' }, '/tmp/o.md')
  expect(argv.slice(0, 4)).toEqual(['codex', 'exec', '-m', 'gpt-6-astra'])
  expect(argv[argv.indexOf('-s') + 1]).toBe('read-only')
  const cursor = argvFor({ vendor: 'cursor', role: 'review', name: 'c', prompt: 'x' }, '')
  expect(cursor).toContain('ask')
  expect(cursor).not.toContain('--force')
})
