import { CheckRegistry } from './registry'
import { SchemaCheck } from './schema'
import { RlsCheck } from './rls'
import { EdgeFunctionsCheck } from './edge-functions'
import { StorageCheck } from './storage'
import { AuthCheck } from './auth'
import { CronCheck } from './cron'
import { DataCheck } from './data'
import { WebhooksCheck } from './webhooks'
import { RealtimeCheck } from './realtime'
import { VaultCheck } from './vault'
import { ExtensionsCheck } from './extensions'

export function createDefaultRegistry(): CheckRegistry {
  const registry = new CheckRegistry()
  registry.register(new SchemaCheck())
  registry.register(new RlsCheck())
  registry.register(new EdgeFunctionsCheck())
  registry.register(new StorageCheck())
  registry.register(new AuthCheck())
  registry.register(new CronCheck())
  registry.register(new DataCheck())
  registry.register(new WebhooksCheck())
  registry.register(new RealtimeCheck())
  registry.register(new VaultCheck())
  registry.register(new ExtensionsCheck())
  return registry
}

export { CheckRegistry } from './registry'
export { Check, type CheckContext } from './base'
export { SchemaCheck } from './schema'
export { RlsCheck } from './rls'
export { EdgeFunctionsCheck } from './edge-functions'
export { StorageCheck } from './storage'
export { AuthCheck } from './auth'
export { CronCheck } from './cron'
export { DataCheck } from './data'
export { WebhooksCheck } from './webhooks'
export { RealtimeCheck } from './realtime'
export { VaultCheck } from './vault'
export { ExtensionsCheck } from './extensions'
