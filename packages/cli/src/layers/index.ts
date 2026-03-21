import { LayerRegistry } from './registry'
import { SchemaLayer } from './schema'
import { RlsLayer } from './rls'
import { EdgeFunctionsLayer } from './edge-functions'
import { StorageLayer } from './storage'
import { AuthLayer } from './auth'
import { CronLayer } from './cron'
import { DataLayer } from './data'
import { WebhooksLayer } from './webhooks'

export function createDefaultRegistry(): LayerRegistry {
  const registry = new LayerRegistry()
  registry.register(new SchemaLayer())
  registry.register(new RlsLayer())
  registry.register(new EdgeFunctionsLayer())
  registry.register(new StorageLayer())
  registry.register(new AuthLayer())
  registry.register(new CronLayer())
  registry.register(new DataLayer())
  registry.register(new WebhooksLayer())
  return registry
}

export { LayerRegistry } from './registry'
export { Layer, type LayerContext } from './base'
export { SchemaLayer } from './schema'
export { RlsLayer } from './rls'
export { EdgeFunctionsLayer } from './edge-functions'
export { StorageLayer } from './storage'
export { AuthLayer } from './auth'
export { CronLayer } from './cron'
export { DataLayer } from './data'
export { WebhooksLayer } from './webhooks'
