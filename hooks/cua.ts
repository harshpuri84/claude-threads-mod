import type { EngineInterface } from 'claude-code'

import { DAEMON_MJS, LAUNCH_MJS } from './bridge'

// Codex computer use through the codex-cu helper (MIT, from the video's two-mods kit), which
// holds one cua_repl server per caller on a Unix socket and answers app approvals from `approve`
// and always-allowed.json only.
// ChatGPT.app's own Node: present wherever Codex computer use works at all.
const NODE = '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node'

let home: string | undefined

export async function homeDir($: EngineInterface) {
  home ??= (await $.process.run(['printenv', 'HOME'])).stdout.trim()

  return home
}

export async function cuaDir($: EngineInterface) {
  return `${await homeDir($)}/.claude/mcp/codex-cu`
}

async function health($: EngineInterface, socketPath: string) {
  try {
    return (await $.http.fetch('http://codex-cu/health', { socketPath })).ok
  } catch {
    return false
  }
}

export type CuaResult = { text: string; isError: boolean; declined: string[]; busy: string[] }

const list = (raw: string | undefined): string[] => {
  try {
    const parsed = JSON.parse(raw ?? '[]') as unknown[]
    return parsed.map(x => (typeof x === 'string' ? x : JSON.stringify(x)))
  } catch {
    return []
  }
}

export async function cuaCall(
  $: EngineInterface,
  path: 'js' | 'reset',
  body: Record<string, unknown>,
): Promise<CuaResult> {
  const dir = await cuaDir($)
  const socketPath = `${dir}/daemon.sock`
  if (!(await $.fs.exists(`${dir}/daemon.mjs`))) {
    await $.process.run(['mkdir', '-p', dir])
    await $.fs.write(`${dir}/daemon.mjs`, DAEMON_MJS)
    await $.fs.write(`${dir}/launch.mjs`, LAUNCH_MJS)
  }
  if (!(await health($, socketPath))) {
    await $.process.run([
      '/bin/sh',
      '-c',
      // mkdir is atomic: only one caller starts the helper; the lock lapses after 10 s.
      // dir and NODE go in as $1 and $2, so the shell never parses the HOME-derived path.
      'if mkdir "$1/.starting" 2>/dev/null; then nohup "$2" "$1/daemon.mjs" > "$1/daemon.log" 2>&1 < /dev/null & (sleep 10; rmdir "$1/.starting") > /dev/null 2>&1 & fi',
      'sh',
      dir,
      NODE,
    ])
    let isUp = false
    for (let i = 0; i < 40 && !isUp; i++) {
      await $.clock.sleep(250)
      isUp = await health($, socketPath)
    }
    if (!isUp) {
      return { text: `The codex-cu helper did not start. See ${dir}/daemon.log.`, isError: true, declined: [], busy: [] }
    }
  }
  const res = await $.http.fetch(`http://codex-cu/${path}`, {
    method: 'POST',
    socketPath,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  return {
    text: res.text,
    isError: !res.ok,
    declined: list(res.headers['x-codex-declined']),
    busy: list(res.headers['x-codex-busy']),
  }
}

export async function allowAlways($: EngineInterface, app: string) {
  const file = `${await cuaDir($)}/always-allowed.json`
  let always: { apps?: string[]; autoApproveAll?: boolean } = {}
  if (await $.fs.exists(file)) {
    try {
      always = JSON.parse(await $.fs.read(file)) as typeof always
    } catch {
      throw new Error(`${file} is not valid JSON; fix it by hand before adding ${app}.`)
    }
  }
  const apps = [...new Set([...(always.apps ?? []), app])]
  await $.fs.write(file, JSON.stringify({ ...always, apps }, null, 2))
}
