export const LAYER_NAMES = [
  'schema', 'rls', 'edge-functions', 'storage', 'auth', 'cron', 'data', 'webhooks',
] as const

export type LayerName = (typeof LAYER_NAMES)[number]

export type Severity = 'critical' | 'warning' | 'info'

export const LAYER_META: Record<LayerName, { number: number; emoji: string; label: string }> = {
  'schema':          { number: 1, emoji: '🗄️',   label: 'Schema' },
  'rls':             { number: 2, emoji: '🔒',   label: 'RLS Policies' },
  'edge-functions':  { number: 3, emoji: '⚡',    label: 'Edge Functions' },
  'storage':         { number: 4, emoji: '🪣',   label: 'Storage' },
  'auth':            { number: 5, emoji: '🔑',   label: 'Auth Config' },
  'cron':            { number: 6, emoji: '⏰',   label: 'Cron Jobs' },
  'data':            { number: 7, emoji: '🗃️',   label: 'Reference Data' },
  'webhooks':        { number: 8, emoji: '⚡🔗', label: 'Webhooks' },
}

export interface DriftIssue {
  id: string
  layer: LayerName
  severity: Severity
  title: string
  description: string
  sourceValue?: unknown
  targetValue?: unknown
  sql?: { up: string; down: string }
}

export interface LayerResult {
  layer: LayerName
  status: 'clean' | 'drifted' | 'error' | 'skipped'
  issues: DriftIssue[]
  error?: string
  durationMs: number
}

export interface ScanResult {
  timestamp: string
  source: string
  target: string
  layers: LayerResult[]
  score: number
  summary: { total: number; critical: number; warning: number; info: number }
}
