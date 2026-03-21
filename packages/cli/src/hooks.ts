/**
 * Minimal hook bus inspired by @plug/core (https://github.com/akalforge/plug).
 * Provides actions (fire-and-forget) and filters (transform pipeline) with priority ordering.
 * When @plug/core is published to npm, this can be replaced with a direct import.
 */

type Listener = (...args: any[]) => unknown | Promise<unknown>
type FilterFn<T = any> = (value: T, ...args: any[]) => T | Promise<T>

interface Entry { fn: Listener; priority: number }

export class HookBus {
  private actions = new Map<string, Entry[]>()
  private filters = new Map<string, Entry[]>()

  on(hook: string, fn: Listener, priority = 10): () => void {
    const bucket = this.actions.get(hook) ?? []
    const entry = { fn, priority }
    bucket.push(entry)
    bucket.sort((a, b) => a.priority - b.priority)
    this.actions.set(hook, bucket)
    return () => {
      const b = this.actions.get(hook)
      if (b) this.actions.set(hook, b.filter(e => e !== entry))
    }
  }

  async emit(hook: string, ...args: unknown[]): Promise<void> {
    for (const entry of this.actions.get(hook) ?? []) {
      await entry.fn(...args)
    }
  }

  addFilter<T>(hook: string, fn: FilterFn<T>, priority = 10): () => void {
    const bucket = this.filters.get(hook) ?? []
    const entry: Entry = { fn: fn as Listener, priority }
    bucket.push(entry)
    bucket.sort((a, b) => a.priority - b.priority)
    this.filters.set(hook, bucket)
    return () => {
      const b = this.filters.get(hook)
      if (b) this.filters.set(hook, b.filter(e => e !== entry))
    }
  }

  async applyFilter<T>(hook: string, value: T, ...args: unknown[]): Promise<T> {
    let result = value
    for (const entry of this.filters.get(hook) ?? []) {
      result = await (entry.fn as FilterFn<T>)(result, ...args)
    }
    return result
  }

  clear(): void {
    this.actions.clear()
    this.filters.clear()
  }
}
