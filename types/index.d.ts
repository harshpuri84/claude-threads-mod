export type Vendor = 'claude' | 'codex' | 'cursor'
export type Role = 'build' | 'review' | 'image'
// 'working' is the running state; 'stopped' is the old name for 'cancelled', kept for stored rows.
export type RunState = 'starting' | 'working' | 'done' | 'failed' | 'cancelled' | 'stopped'

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
  endedAt?: number
  // The "Threads:" notice reached the lead.
  isDelivered?: boolean
}

// <runDir>/run.json: what the mod knows about a run, on disk so a reload or restart can find it.
export type RunManifest = {
  id: string
  vendor: Vendor
  role: Role
  name: string
  model: string
  effort: string
  cwd: string
  startedAt: number
}

// <runDir>/result.json: written once, atomically, when the run ends.
export type RunResult = {
  state: 'done' | 'failed' | 'cancelled'
  exitCode: string
  endedAt: number
  durationMs: number
  tokens?: number
  chars: number
  artifacts: string[]
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
