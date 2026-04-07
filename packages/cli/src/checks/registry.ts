import type { CheckName } from '../types/drift'
import type { Check } from './base'

export class CheckRegistry {
  private checks = new Map<CheckName, Check>()

  register(check: Check): void {
    this.checks.set(check.name, check)
  }

  get(name: CheckName): Check | undefined {
    return this.checks.get(name)
  }

  all(): Check[] {
    return [...this.checks.values()]
  }

  has(name: CheckName): boolean {
    return this.checks.has(name)
  }
}
