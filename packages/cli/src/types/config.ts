export interface EnvironmentConfig {
  dbUrl: string
  projectRef?: string
  apiKey?: string
  /** Base URL for self-hosted Supabase API gateway (e.g. http://localhost:54321). Overrides projectRef-based URL construction. */
  apiUrl?: string
}

export interface LayersConfig {
  data?: { tables: string[] }
}

export interface SupaForgeConfig {
  environments: Record<string, EnvironmentConfig>
  source: string
  target: string
  ignoreSchemas?: string[]
  layers?: LayersConfig
}
