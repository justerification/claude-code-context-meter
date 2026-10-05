export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Reading = { tokens?: number; window: number; percent?: number; limits: Limit[]; usd?: number }

// The on-demand summary of where the session stands.
export type Where = { status: 'idle' | 'asking' | 'ready'; lines: string[] }

declare module 'claude-code' {
  interface PluginState {
    'context-meter': { reading: Reading | null; where: Where }
  }
}
