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
    'Make the image with your image generation tool. End your reply with the absolute path of every image file you made, one per line.',
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

// Cursor's JSON line, parsed from the whole stdout: a tail cut mid-line is not JSON.
const cursorJson = (stdout: string) => {
  try {
    return JSON.parse(stdout.trim().split('\n').pop() ?? '') as {
      result?: unknown
      usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
    }
  } catch {
    return undefined
  }
}

export const finalText = (vendor: Vendor, stdout: string, lastMessage: string | undefined) => {
  if (vendor === 'codex') return (lastMessage ?? '').trim() || stdout.trim().slice(-4000)
  const parsed = cursorJson(stdout)
  if (typeof parsed?.result === 'string') return parsed.result.trim()

  return stdout.trim().slice(-4000)
}

// Total tokens, or undefined when the CLI printed none. Codex ends stderr with "tokens used" and a
// number in the locale's grouping ("61.766" or "61,766"); Cursor puts usage in its JSON line.
export const usageOf = (vendor: Vendor, stdout: string, stderr: string): number | undefined => {
  if (vendor === 'codex') {
    const m = stderr.match(/tokens used\s*\n\s*([\d.,  ]+)\s*$/m)
    const n = m?.[1] ? Number(m[1].replace(/\D/g, '')) : NaN
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  const u = cursorJson(stdout)?.usage
  if (!u) return undefined

  return (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)
}
