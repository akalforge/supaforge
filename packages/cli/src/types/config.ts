export interface EnvironmentConfig {
  dbUrl: string
  projectRef?: string
  apiKey?: string
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
