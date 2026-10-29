export type Vendor = 'claude' | 'codex' | 'cursor'
export type Role = 'build' | 'review' | 'image'
export type RunState = 'working' | 'done' | 'failed' | 'stopped'

export type Thread = {
  id: string
  vendor: Vendor
  name: string
  title: string
  model: string
  effort: string
  startedAt: number
  isRunning: boolean
  isArchived: boolean
  lastActivityAt: number
  tokens?: number
  role?: Role
  run?: RunState
  tail?: string
  runDir?: string
  watcherId?: string
}

export type Plan = { text: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    threads: {
      threads: Thread[]
      plan: Plan | null
      steer: string
      allowed: string[]
      pending: string[]
    }
  }
}
