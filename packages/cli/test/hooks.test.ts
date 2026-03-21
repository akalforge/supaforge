import { describe, it, expect, vi } from 'vitest'
import { HookBus } from '../src/hooks.js'

describe('HookBus', () => {
  it('emits actions to listeners', async () => {
    const bus = new HookBus()
    const fn = vi.fn()
    bus.on('test.action', fn)
    await bus.emit('test.action', 'arg1', 'arg2')
    expect(fn).toHaveBeenCalledWith('arg1', 'arg2')
  })

  it('respects priority ordering', async () => {
    const bus = new HookBus()
    const order: number[] = []
    bus.on('test', () => { order.push(2) }, 20)
    bus.on('test', () => { order.push(1) }, 10)
    await bus.emit('test')
    expect(order).toEqual([1, 2])
  })

  it('applies filters in chain', async () => {
    const bus = new HookBus()
    bus.addFilter('test.filter', (value: number) => value * 2)
    bus.addFilter('test.filter', (value: number) => value + 1)
    const result = await bus.applyFilter('test.filter', 5)
    expect(result).toBe(11) // (5 * 2) + 1
  })

  it('respects filter priority', async () => {
    const bus = new HookBus()
    bus.addFilter('test', (v: number) => v + 1, 20) // runs second
    bus.addFilter('test', (v: number) => v * 2, 10) // runs first
    const result = await bus.applyFilter('test', 5)
    expect(result).toBe(11) // (5 * 2) + 1
  })

  it('returns unsubscribe function for actions', async () => {
    const bus = new HookBus()
    const fn = vi.fn()
    const unsub = bus.on('test', fn)
    unsub()
    await bus.emit('test')
    expect(fn).not.toHaveBeenCalled()
  })

  it('returns unsubscribe function for filters', async () => {
    const bus = new HookBus()
    const unsub = bus.addFilter('test', (v: number) => v * 100)
    unsub()
    const result = await bus.applyFilter('test', 5)
    expect(result).toBe(5)
  })

  it('does nothing when emitting unregistered hook', async () => {
    const bus = new HookBus()
    await bus.emit('nonexistent') // no error
  })

  it('returns original value when no filters registered', async () => {
    const bus = new HookBus()
    const result = await bus.applyFilter('nonexistent', 42)
    expect(result).toBe(42)
  })

  it('clears all listeners', async () => {
    const bus = new HookBus()
    const fn = vi.fn()
    bus.on('test', fn)
    bus.addFilter('test', (v: any) => v)
    bus.clear()

    await bus.emit('test')
    expect(fn).not.toHaveBeenCalled()

    const result = await bus.applyFilter('test', 42)
    expect(result).toBe(42)
  })

  it('handles async listeners', async () => {
    const bus = new HookBus()
    const results: number[] = []
    bus.on('test', async () => {
      await new Promise(r => setTimeout(r, 10))
      results.push(1)
    })
    bus.on('test', () => { results.push(2) })
    await bus.emit('test')
    expect(results).toEqual([1, 2])
  })
})
