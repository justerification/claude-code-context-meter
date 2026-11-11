export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Reading = { tokens?: number; window: number; percent?: number; limits: Limit[]; usd?: number }

// The plan's per-model weekly windows (Fable), which the engine does not hand to mods: read from
// the engine's own usage report. `at` is when it was last asked for, answered or not.
// `windows` are the plan's own (weekly all models), kept for sessions the engine reports none to.
export type Plan = { at: number; scoped: Limit[]; windows?: Limit[] }

declare module 'claude-code' {
  interface PluginState {
    'context-meter': { reading: Reading | null; plan: Plan | null }
  }
}
