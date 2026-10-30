import type { Role, Vendor } from '../types'

export type ExternalInput = {
  vendor: Vendor
  role: Role
  name: string
  prompt: string
  model?: string
  effort?: string
  cwd?: string
}

const CODEX_DEFAULTS: Record<Role, { model: string; effort: string }> = {
  build: { model: 'gpt-6.1-sol', effort: 'high' },
  review: { model: 'gpt-6-astra', effort: 'high' },
  image: { model: 'gpt-6-luna', effort: 'low' },
}

const CURSOR_DEFAULT = 'composer-2.5'

const ROLE_NOTE: Record<Role, string> = {
  build: '',
  review: 'Review only. Do not edit any file. Give findings ranked by severity, each with file and line.',
  image:
    'Make the image with your image generation tool. End your reply with the absolute path of every image file you made.',
}

export const resolveRun = (input: ExternalInput) => {
  const model =
    input.model ?? (input.vendor === 'codex' ? CODEX_DEFAULTS[input.role].model : CURSOR_DEFAULT)
  const effort = input.effort ?? (input.vendor === 'codex' ? CODEX_DEFAULTS[input.role].effort : 'n/a')
  const prompt = ROLE_NOTE[input.role] ? `${input.prompt}\n\n${ROLE_NOTE[input.role]}` : input.prompt

  return { model, effort, prompt }
}

export const argvFor = (input: ExternalInput, outFile: string) => {
  const { model, effort, prompt } = resolveRun(input)
  if (input.vendor === 'codex') {
    const sandbox = input.role === 'build' ? 'workspace-write' : 'read-only'
    const argv = ['codex', 'exec', '-m', model, '-c', `model_reasoning_effort=${effort}`]
    argv.push('-s', sandbox, '--skip-git-repo-check', '-o', outFile)
    // `--` keeps a prompt such as `--help` or `review` from parsing as an option or subcommand.
    argv.push('--', prompt)

    return argv
  }
  // `--` alone does not stop cursor-agent dispatching `status` or `logout`; naming `agent` does.
  const argv = ['cursor-agent', 'agent', '-p', '--model', model, '--output-format', 'json', '--trust']
  if (input.role === 'build') argv.push('--force')
  else argv.push('--mode', 'ask')
  argv.push('--', prompt)

  return argv
}

export const finalText = (vendor: Vendor, stdout: string, lastMessage: string | undefined) => {
  if (vendor === 'codex') return (lastMessage ?? '').trim() || stdout.trim().slice(-4000)
  const line = stdout.trim().split('\n').pop() ?? ''
  try {
    const parsed = JSON.parse(line) as { result?: string }
    if (typeof parsed.result === 'string') return parsed.result.trim()
  } catch {
    // not JSON: fall through to the raw tail
  }

  return stdout.trim().slice(-4000)
}
