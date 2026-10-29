import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Plan, Role, Thread, Vendor } from '../types'
import { allowAlways, cuaCall, homeDir } from './cua'
import { argvFor, finalText, resolveRun } from './external'
import type { ExternalInput } from './external'

const PANE = 'threads'
const STUCK_MS = 10 * 60_000
const START = 'mcp__ccd_session__start_session'
const LIST = 'mcp__ccd_session_mgmt__list_sessions'
const USAGE = 'mcp__ccd_session_mgmt__get_usage'
const SEND = 'mcp__ccd_session_mgmt__send_message'
const STOP = 'mcp__ccd_session_mgmt__stop_session'
const RUN = 'run_external'

const threads = atom({ plugin: 'threads', key: 'threads' } as const, [])
const plan = atom({ plugin: 'threads', key: 'plan' } as const, null)
const steer = atom({ plugin: 'threads', key: 'steer' } as const, '')
const allowed = atom({ plugin: 'threads', key: 'allowed' } as const, [])
const pending = atom({ plugin: 'threads', key: 'pending' } as const, [])

const LEAD = `# Threads (lead mode)
When the user asks for threads, helpers or a team, this chat is the lead.
- Claude helpers: start each with ${START}: initiation "user_asked", context "fresh", a short \`name\`, a full \`prompt\` and \`background\`, and the \`model\` and \`effort\` the user named. When the user leaves the choice to you: plan and review on the strongest model at high effort, build on a Sonnet id at medium, mechanical checks on a Haiku id at low.
- Codex and Cursor helpers: call mcp__threads__${RUN}. Codex roles: build (gpt-6.1-sol, can write in cwd), review (gpt-6-astra, read-only; use Astra for review and thinking only, never to build), image (gpt-6-luna drives Codex image generation and returns file paths). For Mac apps use mcp__threads__cua, not a Codex run: a background Codex run cannot answer app approvals. Cursor takes any model id from \`cursor-agent models\`; build may write, review is read-only ask mode. The call returns at once with arguments for a Haiku watcher session (w-<name>): start it right away with ${START} so the person can follow the run in the sidebar; its note brings the run's result back here. If the note is cut, read the run's final.md in the Files folder it names.
- Desktop apps on this Mac: call mcp__threads__cua. It runs JavaScript in Codex's persistent cua_repl with a \`cua\` object, in the background, without moving the person's cursor. First call (and after mcp__threads__cua_reset): exactly one entry call, such as \`let app = await cua.getApp("Calculator");\`; its result carries the API docs and the app's accessibility tree. Read them and use only documented APIs. Prefer element indices over coordinates, re-read state after each action, and end a batch with \`await app.getAXState()\`. Each app needs the person's approval: when a result says they are being asked, stop and wait for the "Threads:" message. Never work around a denial. Do not click Send, Submit, Delete or Buy unless the person asked for exactly that.
Pass work between helpers as files, and say in each brief which file the previous helper leaves. The Threads pane tracks status, stuck helpers and usage; the user steers from it. When results come back, check each and write one merged answer here.`

type Row = {
  sessionId: string
  title?: string
  name?: string
  startedBy?: string
  isRunning?: boolean
  isArchived?: boolean
  lastActivityAt?: string
}

const parse = <T,>(text: unknown): T | undefined => {
  if (typeof text !== 'string') return undefined
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

const shortModel = (model: string) =>
  model.replace(/^claude-/, '').replace(/-\d{8}$/, '') || 'inherit'

const ago = (ms: number) => {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  return `${Math.floor(min / 60)}h${min % 60}m`
}

const vendorOf = (t: Thread): Vendor => t.vendor ?? 'claude'

const stateOf = (t: Thread, now: number) => {
  if (vendorOf(t) !== 'claude') {
    if (t.run === 'working' && now - t.lastActivityAt > STUCK_MS) return 'stuck'
    return t.run ?? 'working'
  }
  if (t.isArchived) return 'archived'
  if (!t.isRunning) return 'idle'
  if (now - t.lastActivityAt > STUCK_MS) return 'stuck'
  return 'working'
}

const patch = ($: EngineInterface, id: string, fields: Partial<Thread>) =>
  update($, threads, (list: Thread[]): Thread[] =>
    list.map(t => (t.id === id ? { ...t, ...fields } : t)),
  )

let selfId: string | undefined

async function getSelf($: EngineInterface) {
  if (!selfId) {
    const self = parse<{ sessionId: string }>(
      (await callTool($, { tool: 'mcp__ccd_session_mgmt__get_session', session_id: 'self' })).text,
    )
    selfId = self?.sessionId
  }

  return selfId ?? 'default'
}

// Loose caller: the laid MCP tool types make literal names too deep for tsc.
const callTool = ($: EngineInterface, input: { tool: string } & Record<string, unknown>) =>
  ($.tool as unknown as { call: (i: unknown) => Promise<{ text?: unknown }> }).call(input)

async function refresh($: EngineInterface) {
  await getSelf($)
  const rows =
    parse<Row[]>(
      (await callTool($, { tool: LIST, linked: true, include_archived: true, limit: 50 })).text,
    ) ?? []
  const known = await read($, threads)
  const watchers = new Set(known.map(t => t.watcherId).filter(Boolean))
  const mine = rows.filter(
    r =>
      !watchers.has(r.sessionId) &&
      !(r.name ?? '').startsWith('w-') &&
      (r.startedBy === selfId || known.some(t => t.id === r.sessionId)),
  )
  const fresh: Thread[] = []
  for (const r of mine) {
    const old = known.find(t => t.id === r.sessionId)
    let tokens = old?.tokens
    if (r.isRunning) {
      const usage = parse<{ context?: { tokensUsed?: number } }>(
        (await callTool($, { tool: USAGE, session_id: r.sessionId })).text,
      )
      tokens = usage?.context?.tokensUsed ?? tokens
    }
    fresh.push({
      id: r.sessionId,
      vendor: 'claude',
      name: r.name ?? old?.name ?? r.sessionId.slice(6, 14),
      title: r.title ?? old?.title ?? '',
      model: old?.model ?? 'inherit',
      effort: old?.effort ?? 'inherit',
      startedAt: old?.startedAt ?? Date.now(),
      isRunning: r.isRunning ?? false,
      isArchived: r.isArchived ?? false,
      lastActivityAt: r.lastActivityAt ? Date.parse(r.lastActivityAt) : Date.now(),
      tokens,
    })
  }
  await update($, threads, list => [
    ...fresh,
    ...list.filter(t => !fresh.some(f => f.id === t.id)),
  ])

  const account = parse<{ plan?: { windows?: { label: string; percentUsed: number }[] } }>(
    (await callTool($, { tool: USAGE })).text,
  )
  const windows = account?.plan?.windows ?? []
  if (windows.length > 0) {
    await update($, plan, () => ({
      text: windows.map(w => `${w.label} ${w.percentUsed}%`).join(' · '),
      at: Date.now(),
    }))
  }
}

async function sendTo($: EngineInterface, id: string, message: string) {
  const res = await callTool($, { tool: SEND, session_id: id, message })
  return typeof res.text === 'string' ? res.text : ''
}

const quote = (arg: string) => `'${arg.replace(/'/g, `'\\''`)}'`

// Each run is a detached shell job (reload-safe) under ~/.claude/mcp/threads-runs/<id>/ that writes
// pid, stdout.log, stderr.log, last.md (Codex) and finally exit, so it outlives mod reloads.
async function startExternal($: EngineInterface, id: string, input: ExternalInput) {
  const runDir = `${await homeDir($)}/.claude/mcp/threads-runs/${id}`
  await $.process.run(['mkdir', '-p', runDir])
  const cwd = input.cwd ?? (await $.process.run(['pwd'])).stdout.trim()
  const script = [
    `cd ${quote(cwd)} || { echo 1 > ${quote(`${runDir}/exit`)}; exit 1; }`,
    `echo $$ > ${quote(`${runDir}/pid`)}`,
    `${argvFor(input, `${runDir}/last.md`).map(quote).join(' ')} < /dev/null > ${quote(`${runDir}/stdout.log`)} 2> ${quote(`${runDir}/stderr.log`)}`,
    `echo $? > ${quote(`${runDir}/exit`)}`,
  ].join('\n')
  await $.fs.write(`${runDir}/run.sh`, `${script}\n`)
  await $.fs.write(`${runDir}/watch.sh`, watchScript(runDir))
  await $.process.run(['/bin/sh', '-c', `nohup /bin/sh ${quote(`${runDir}/run.sh`)} > /dev/null 2>&1 &`])

  return runDir
}

// What the sidebar watcher runs: prints the log as it grows, then RESULT and final.md, which the
// collector writes when the job ends. Gives up after 9 minutes so one Bash call never times out.
const watchScript = (runDir: string) => `d=${quote(runDir)}
end=$(( $(date +%s) + 540 ))
off=0
while [ $(date +%s) -lt $end ]; do
  if [ -f "$d/final.md" ]; then echo RESULT; cat "$d/final.md"; exit 0; fi
  if [ -f "$d/exit" ] && [ $(( $(date +%s) - $(stat -f %m "$d/exit") )) -gt 90 ]; then
    echo RESULT; echo "(exit $(cat "$d/exit"); the Threads mod wrote no final.md)"; tail -c 3000 "$d/stdout.log"; exit 0
  fi
  size=$(wc -c < "$d/stdout.log" 2>/dev/null || echo 0)
  if [ "$size" -gt "$off" ]; then tail -c +$((off + 1)) "$d/stdout.log" | head -c 3000; echo; off=$size; fi
  sleep 15
done
echo STILL RUNNING
`

// The watcher is started by the lead's own start_session call: a plugin's call has no request
// behind it, so the auto-mode check refuses it. The START hook then links it to the run.
const watcherArgs = (t: Thread, runDir: string) => ({
  initiation: 'user_asked',
  context: 'fresh',
  name: `w-${t.name}`.slice(0, 24),
  title: `${t.vendor} ${t.role ?? 'build'} · ${t.name} (${t.model})`.slice(0, 59),
  model: 'claude-haiku-5-5',
  effort: 'low',
  use_worktree: false,
  prompt: `You watch one ${t.vendor} run and relay its result. Do no other work: no edits, no other commands.\n1. Run exactly \`/bin/sh ${runDir}/watch.sh\` with the Bash tool, timeout 600000.\n2. If its output ends with STILL RUNNING, run it again.\n3. When its output has a line RESULT, end your turn with everything after that line, verbatim, with nothing added.`,
  background: `The Threads mod in the lead session started a ${t.vendor} ${t.role ?? 'build'} run on ${t.model} named ${t.name}. Its files are in ${runDir}. This session exists so the person can follow that run in the sidebar, and so its result reaches the lead.`,
})

async function stopExternal($: EngineInterface, t: Thread) {
  if (!t.runDir) return
  const pid = quote(`${t.runDir}/pid`)
  await $.process.run(['/bin/sh', '-c', `p=$(cat ${pid}); pkill -TERM -P "$p"; kill -TERM "$p"; echo stopped > ${quote(`${t.runDir}/exit`)}`])
}

async function collect($: EngineInterface) {
  const open = (await read($, threads)).filter(t => t.runDir && t.run === 'working')
  for (const t of open) {
    const dir = t.runDir ?? ''
    if (!(await $.fs.exists(`${dir}/exit`))) {
      const log = `${dir}/stdout.log`
      if (await $.fs.exists(log)) {
        const { mtimeMs } = await $.fs.stat(log)
        const tail = (await $.process.run(['tail', '-c', '400', log])).stdout
        const line = tail.trim().split('\n').filter(Boolean).slice(-1)[0]?.slice(-160)
        await patch($, t.id, { lastActivityAt: Math.max(mtimeMs, t.startedAt), ...(line ? { tail: line } : {}) })
      }
      continue
    }
    const code = (await $.fs.read(`${dir}/exit`)).trim()
    const state = code === 'stopped' ? 'stopped' : code === '0' ? 'done' : 'failed'
    // Mark it first, so a reload mid-delivery never sends it twice.
    await patch($, t.id, { run: state, isRunning: false, lastActivityAt: Date.now() })
    const last = (await $.fs.exists(`${dir}/last.md`)) ? await $.fs.read(`${dir}/last.md`) : undefined
    const stdout = (await $.process.run(['tail', '-c', '20000', `${dir}/stdout.log`])).stdout
    const err = state === 'failed' ? (await $.process.run(['tail', '-c', '1500', `${dir}/stderr.log`])).stdout.trim() : ''
    let text = finalText(t.vendor, stdout, last)
    if (err) text += `\n\nstderr tail:\n${err}`
    if (t.role === 'image') {
      // Codex saves generated images itself; the model often cannot see where. List what this run wrote.
      const found = await $.process.run([
        'find', `${await homeDir($)}/.codex/generated_images`, '-name', '*.png', '-newer', `${dir}/run.sh`,
      ])
      const pngs = found.stdout.trim().split('\n').filter(Boolean)
      text += pngs.length > 0 ? `\n\nImages written during this run:\n${pngs.join('\n')}` : '\n\nNo image file was written during this run.'
    }
    await patch($, t.id, { tail: text.split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 160) ?? '' })
    const cut = text.length > 6000 ? `\n\n(cut at 6000 of ${text.length} characters; the full text is in ${dir})` : ''
    await $.fs.write(`${dir}/final.md`, `${t.vendor} ${t.role ?? 'build'} on ${t.model}: ${state}\n\n${text.slice(0, 6000) || '(empty)'}${cut}\n\nFiles: ${dir}\n`)
    // A watcher session reports it natively; post here only when there is none.
    if (t.watcherId) continue
    try {
      await $.prompt.submit({
        text: `Threads: ${t.vendor} thread "${t.name}" (${t.model}, ${t.role ?? 'build'}) ${state}.\n\nIts final message:\n\n${text.slice(0, 6000) || '(empty)'}${cut}\n\nFiles: ${dir}`,
      })
    } catch {
      // Not delivered: put it back so the next tick tries again.
      await patch($, t.id, { run: 'working', isRunning: true })
    }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'threads',
      description: 'Open the Threads pane: helper sessions this chat leads',
    })
    await $.tool.register({
      name: RUN,
      isDeferred: false,
      description:
        'Start a Codex or Cursor helper run in the background and track it in the Threads pane. Returns at once. A Haiku watcher session (w-<name>) in the sidebar follows the run and reports its result back here. Codex roles: build (gpt-6.1-sol, writes in cwd), review (gpt-6-astra, read-only), image (gpt-6-luna with Codex image generation, returns file paths). For Mac apps use the cua tool instead. Cursor: any model id; build writes, review is read-only ask mode.',
      inputSchema: {
        type: 'object',
        properties: {
          vendor: { type: 'string', enum: ['codex', 'cursor'] },
          role: { type: 'string', enum: ['build', 'review', 'image'] },
          name: { type: 'string', description: 'Short handle, [a-z0-9-]' },
          prompt: { type: 'string', description: 'The full brief: task, files, what done looks like' },
          model: { type: 'string', description: 'Optional model id; defaults by vendor and role' },
          effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'], description: 'Codex only' },
          cwd: { type: 'string', description: 'Absolute working folder; defaults to this session folder' },
        },
        required: ['vendor', 'role', 'name', 'prompt'],
      },
    })
    await $.tool.register({
      name: 'cua',
      isDeferred: false,
      description:
        "Codex computer use: control native Mac apps in the background (real clicks, typing, drags; no hover) by running JavaScript in Codex's persistent cua_repl with a `cua` object. First call, and after cua_reset: exactly one entry call, e.g. `let app = await cua.getApp(\"Calculator\");`. Its result carries the API docs and UI state; then use only documented APIs. Each app needs the person's approval in the Threads pane.",
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'JavaScript to run in the cua_repl runtime' },
          title: { type: 'string', description: 'Short description of what the code does' },
          timeout_ms: { type: 'integer', minimum: 1, description: 'Default 30000' },
        },
        required: ['code'],
      },
    })
    await $.tool.register({
      name: 'cua_reset',
      isDeferred: false,
      description: 'Reset the Codex computer-use REPL for this chat and release its apps.',
      inputSchema: { type: 'object', properties: {} },
    })
    $.clock.every(10_000, () => void collect($))
    $.clock.every(20_000, () => {
      void read($, threads).then(list =>
        list.some(t => vendorOf(t) === 'claude') ? refresh($) : undefined,
      )
    })
    if ((await read($, threads)).length > 0) void $.ui.open({ id: PANE, title: 'Threads' })

    return next(e)
  })

  on('command.run', { command: 'threads' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Threads' })

    return { text: 'Threads pane opened.' }
  })

  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)

    return { sections: [...out.sections, { id: 'threads:lead', text: LEAD, scope: 'session' }] }
  })

  on('tool.call', { tool: 'mcp__threads__run_external' }, async ($, e) => {
    const raw = e as unknown as Record<string, unknown>
    const vendor = raw.vendor
    const role = raw.role
    if ((vendor !== 'codex' && vendor !== 'cursor') || typeof raw.prompt !== 'string') {
      return { deny: 'vendor must be codex or cursor, and prompt is required.' }
    }
    if (role === 'computer') return { deny: 'Use the mcp__threads__cua tool for Mac apps.' }
    if (vendor === 'cursor' && role === 'image') {
      return { deny: 'Cursor runs take role build or review only.' }
    }
    const input: ExternalInput = {
      vendor,
      role: (['build', 'review', 'image'].includes(String(role)) ? role : 'build') as Role,
      name: String(raw.name ?? vendor),
      prompt: raw.prompt,
      model: typeof raw.model === 'string' ? raw.model : undefined,
      effort: typeof raw.effort === 'string' ? raw.effort : undefined,
      cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
    }
    const { model, effort } = resolveRun(input)
    const id = `${vendor}_${crypto.randomUUID().slice(0, 8)}`
    const thread: Thread = {
      id,
      vendor,
      role: input.role,
      run: 'working',
      name: input.name,
      title: input.prompt.split('\n')[0]?.slice(0, 80) ?? '',
      model,
      effort,
      startedAt: Date.now(),
      isRunning: true,
      isArchived: false,
      lastActivityAt: Date.now(),
    }
    await update($, threads, list => [...list, thread])
    const runDir = await startExternal($, id, input)
    await patch($, id, { runDir })
    void $.ui.open({ id: PANE, title: 'Threads' })
    const text = `Started ${vendor} thread "${input.name}" (${id}) on ${model}, role ${input.role}. Now start its sidebar watcher: call ${START} with exactly these arguments, then end your turn without waiting:\n${JSON.stringify(watcherArgs(thread, runDir), null, 1)}\nThe watcher's note brings the result back here. If no watcher starts, the result arrives as a "Threads:" prompt instead.`

    return { result: text }
  }).catch(() => ({ deny: 'The Threads mod could not start the run.' }))

  on('tool.call', { tool: 'mcp__threads__cua' }, async ($, e) => {
    const raw = e as unknown as Record<string, unknown>
    if (typeof raw.code !== 'string') return { deny: 'code is required.' }
    const out = await cuaCall($, 'js', {
      code: raw.code,
      title: typeof raw.title === 'string' ? raw.title.slice(0, 80) : 'Threads computer use',
      timeout_ms: typeof raw.timeout_ms === 'number' ? raw.timeout_ms : 30_000,
      session: await getSelf($),
      approve: await read($, allowed),
    })
    let text = out.text
    if (out.declined.length > 0) {
      const apps = [...new Set(out.declined)]
      await update($, pending, (list: string[]): string[] => [...new Set([...list, ...apps])])
      void $.ui.open({ id: PANE, title: 'Threads' })
      text += `\n\nThe person is being asked to approve ${apps.join(', ')} in the Threads pane. Stop here and wait: a "Threads:" message tells you what they decided.`
    }
    if (out.busy.length > 0) text += `\n\nBusy: another session holds ${out.busy.join(', ')}.`

    return { result: text }
  }).catch(() => ({ deny: 'The codex-cu helper failed. See ~/.claude/mcp/codex-cu/daemon.log.' }))

  on('tool.call', { tool: 'mcp__threads__cua_reset' }, async $ => {
    const out = await cuaCall($, 'reset', { session: await getSelf($) })

    return { result: out.text || 'Reset.' }
  }).catch(() => ({ deny: 'The codex-cu helper failed. See ~/.claude/mcp/codex-cu/daemon.log.' }))

  on('tool.call', { tool: START }, async ($, e, next) => {
    const ran = await next(e)
    const text = typeof ran.text === 'string' ? ran.text : ''
    const id = text.match(/local_[0-9a-f-]{36}/)?.[0]
    const input = e as unknown as Record<string, unknown>
    const isWatcher = String(input.name ?? '').startsWith('w-')
    if (id && isWatcher) {
      const runName = String(input.name).slice(2)
      await update($, threads, (list: Thread[]): Thread[] =>
        list.map(t => (t.runDir && !t.watcherId && t.name.slice(0, 22) === runName ? { ...t, watcherId: id } : t)),
      )
    }
    if (id && !isWatcher && input.initiation !== 'offer' && input.initiation !== 'own_initiative') {
      const thread: Thread = {
        id,
        vendor: 'claude',
        name: String(input.name ?? id.slice(6, 14)),
        title: String(input.title ?? ''),
        model: String(input.model ?? 'inherit'),
        effort: String(input.effort ?? 'inherit'),
        startedAt: Date.now(),
        isRunning: true,
        isArchived: false,
        lastActivityAt: Date.now(),
      }
      await update($, threads, list => [...list.filter(t => t.id !== id), thread])
      void $.ui.open({ id: PANE, title: 'Threads' })
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : undefined
    const list = await read($, threads)
    const usage = await read($, plan)
    const draft = await read($, steer)
    const now = Date.now()
    const live = list.filter(t => !t.isArchived)
    const claudeRunning = live.filter(t => vendorOf(t) === 'claude' && t.isRunning)
    const working = live.filter(t => ['working', 'stuck'].includes(stateOf(t, now)))
    const stuck = live.filter(t => stateOf(t, now) === 'stuck')
    const asking = await read($, pending)
    const decide = async (app: string, choice: 'chat' | 'always' | 'deny') => {
      await update($, pending, (list: string[]): string[] => list.filter(a => a !== app))
      if (choice === 'deny') {
        await $.prompt.submit({ text: `Threads: the person denied computer use in ${app}. Do not use it or work around it.` })
        return
      }
      await update($, allowed, (list: string[]): string[] => [...new Set([...list, app])])
      if (choice === 'always') await allowAlways($, app)
      await $.prompt.submit({
        text: `Threads: the person allowed computer use in ${app}${choice === 'always' ? ' (always)' : ' for this chat'}. Retry the mcp__threads__cua call.`,
      })
    }

    const steerAll = async (text: string) => {
      const message = text.trim()
      if (!message) return
      for (const t of claudeRunning) await sendTo($, t.id, `From the lead: ${message}`)
      await update($, steer, () => '')
      $.ui.toast(`Sent to ${claudeRunning.length} Claude thread${claudeRunning.length === 1 ? '' : 's'}.`)
    }

    return (
      <Box flexDirection="column" gap={1}>
        {asking.map(app => (
          <Box key={`ask-${app}`} flexDirection="column">
            <Text bold>Allow Codex computer use in {app}?</Text>
            <Box flexDirection="row" gap={1}>
              <Button key={`chat-${app}`} variant="primary" label="Allow for this chat" onPress={() => decide(app, 'chat')} />
              <Button key={`always-${app}`} label="Always allow" onPress={() => decide(app, 'always')} />
              <Button key={`deny-${app}`} label="Deny" onPress={() => decide(app, 'deny')} />
            </Box>
          </Box>
        ))}
        <Text>
          {live.length} threads · {working.length} running · {stuck.length} stuck
        </Text>
        {usage && <Text dimColor>Claude plan: {usage.text}</Text>}
        {live.length === 0 && (
          <Text dimColor>No threads yet. Ask this chat to start helpers on a model.</Text>
        )}
        {live.map(t => {
          const state = stateOf(t, now)
          const vendor = vendorOf(t)
          return (
            <Box key={t.id} flexDirection="column">
              <Text bold color={state === 'stuck' || state === 'failed' ? 'red' : undefined}>
                {state} · {t.name} · {vendor}
                {t.role ? ` ${t.role}` : ''}
              </Text>
              <Text dimColor>
                {shortModel(t.model)} · effort {t.effort} · active {ago(now - t.lastActivityAt)} ago
                {t.tokens !== undefined ? ` · ${Math.round(t.tokens / 1000)}k ctx` : ''}
              </Text>
              {t.title && <Text dimColor>{t.title}</Text>}
              {t.tail && <Text dimColor>{t.tail}</Text>}
              {t.watcherId && <Text dimColor>Sidebar: w-{t.name}</Text>}
              <Box flexDirection="row" gap={1}>
                {vendor === 'claude' && (
                  <Button
                    key={`status-${t.id}`}
                    label="Ask status"
                    onPress={async () => {
                      await sendTo($, t.id, 'From the lead: report your status in three lines: done, doing, blocked.')
                      $.ui.toast(`Asked ${t.name} for status.`)
                    }}
                  />
                )}
                {vendor === 'claude' && t.isRunning && (
                  <Button
                    key={`stop-${t.id}`}
                    label="Stop"
                    onPress={async () => {
                      await callTool($, { tool: STOP, session_id: t.id })
                      await refresh($)
                    }}
                  />
                )}
                {vendor !== 'claude' && t.run === 'working' && (
                  <Button
                    key={`stop-${t.id}`}
                    label="Stop"
                    onPress={async () => {
                      await stopExternal($, t)
                      $.ui.toast(`Stopping ${t.name}.`)
                    }}
                  />
                )}
              </Box>
            </Box>
          )
        })}
        {claudeRunning.length > 0 && Input && (
          <Input
            key="steer"
            label="Steer Claude threads"
            placeholder="Message every running Claude thread"
            submitLabel="send"
            value={draft}
            onSubmit={steerAll}
          />
        )}
        {live.length > 0 && (
          <Box flexDirection="row" gap={1}>
            <Button
              key="gather"
              variant="primary"
              label="Gather results"
              onPress={async () => {
                const names = live.map(t => `${t.name} (${vendorOf(t)}, ${t.id})`).join(', ')
                await $.prompt.submit({
                  text: `Gather the results from my threads: ${names}. Read what each one reported or left on disk, check it, and write one merged answer.`,
                })
              }}
            />
            <Button key="refresh" label="Refresh" onPress={() => refresh($)} />
          </Box>
        )}
      </Box>
    )
  })
}
