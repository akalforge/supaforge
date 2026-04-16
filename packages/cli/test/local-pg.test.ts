import { describe, it, expect, vi } from 'vitest'
import {
  detectRuntime,
  startLocalPg,
  stopLocalPg,
  CONTAINER_NAME,
  PG_IMAGE,
  LOCAL_PG_USER,
  LOCAL_PG_PASSWORD,
  DEFAULT_LOCAL_PORT,
  type ExecFn,
  type ConnectFn,
} from '../src/local-pg.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeExecFn(available: string[]): ExecFn {
  return vi.fn(async (cmd: string, args: string[]) => {
    // Runtime detection: --version
    if (args[0] === '--version') {
      if (available.includes(cmd)) {
        return { stdout: `${cmd} version 5.0.0`, stderr: '' }
      }
      throw new Error(`${cmd}: command not found`)
    }
    // Container inspect
    if (args[0] === 'inspect') {
      throw new Error('No such container')
    }
    // Default: succeed
    return { stdout: '', stderr: '' }
  })
}

function makeConnectFn(succeed = true): ConnectFn {
  return vi.fn(async () => {
    if (!succeed) throw new Error('Connection refused')
  })
}

// ─── detectRuntime ───────────────────────────────────────────────────────────

describe('detectRuntime', () => {
  it('returns podman when both are available (prefers podman)', async () => {
    const exec = makeExecFn(['podman', 'docker'])
    const result = await detectRuntime(exec)
    expect(result).toBe('podman')
    // Should only check podman, not docker (short-circuit)
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('returns docker when only docker is available', async () => {
    const exec = makeExecFn(['docker'])
    const result = await detectRuntime(exec)
    expect(result).toBe('docker')
    expect(exec).toHaveBeenCalledTimes(2) // tried podman first
  })

  it('returns null when neither is available', async () => {
    const exec = makeExecFn([])
    const result = await detectRuntime(exec)
    expect(result).toBeNull()
    expect(exec).toHaveBeenCalledTimes(2)
  })
})

// ─── startLocalPg ────────────────────────────────────────────────────────────

describe('startLocalPg', () => {
  it('throws when no runtime is available', async () => {
    const exec = makeExecFn([])
    await expect(
      startLocalPg({ execFn: exec, connectFn: makeConnectFn() }),
    ).rejects.toThrow('No container runtime found')
  })

  it('starts a container with correct args', async () => {
    const exec: ExecFn = vi.fn(async (cmd: string, args: string[]) => {
      if (args[0] === '--version') return { stdout: 'podman version 5.0', stderr: '' }
      if (args[0] === 'inspect') throw new Error('No such container')
      return { stdout: 'container-id-abc123', stderr: '' }
    })
    const connect = makeConnectFn(true)

    const info = await startLocalPg({ execFn: exec, connectFn: connect })

    expect(info.runtime).toBe('podman')
    expect(info.port).toBe(DEFAULT_LOCAL_PORT)
    expect(info.containerName).toBe(CONTAINER_NAME)
    expect(info.url).toContain(`localhost:${DEFAULT_LOCAL_PORT}`)

    // Should have called: detect(--version), inspect, run
    expect(exec).toHaveBeenCalledTimes(3)
    const runCall = (exec as ReturnType<typeof vi.fn>).mock.calls[2]
    expect(runCall[0]).toBe('podman')
    expect(runCall[1]).toContain('run')
    expect(runCall[1]).toContain(PG_IMAGE)
  })

  it('reuses already-running container', async () => {
    const exec: ExecFn = vi.fn(async (cmd: string, args: string[]) => {
      if (args[0] === '--version') return { stdout: 'podman version 5.0', stderr: '' }
      if (args[0] === 'inspect') return { stdout: 'true', stderr: '' }
      return { stdout: '', stderr: '' }
    })
    const connect = makeConnectFn(true)

    const info = await startLocalPg({ execFn: exec, connectFn: connect })

    expect(info.runtime).toBe('podman')
    // Should NOT have called 'run' — only detect + inspect
    expect(exec).toHaveBeenCalledTimes(2)
    // connectFn should NOT have been called (already running = skip wait)
    expect(connect).not.toHaveBeenCalled()
  })

  it('removes stopped container before starting new one', async () => {
    const exec: ExecFn = vi.fn(async (cmd: string, args: string[]) => {
      if (args[0] === '--version') {
        if (cmd === 'podman') throw new Error('not found')
        return { stdout: 'docker version 27.0', stderr: '' }
      }
      if (args[0] === 'inspect') return { stdout: 'false', stderr: '' }  // stopped
      if (args[0] === 'rm') return { stdout: '', stderr: '' }
      if (args[0] === 'run') return { stdout: 'new-container-id', stderr: '' }
      return { stdout: '', stderr: '' }
    })
    const connect = makeConnectFn(true)

    const info = await startLocalPg({ execFn: exec, connectFn: connect })

    expect(info.runtime).toBe('docker')
    // Should have called: detect(podman fail), detect(docker ok), inspect, rm, run
    expect(exec).toHaveBeenCalledTimes(5)
    const rmCall = (exec as ReturnType<typeof vi.fn>).mock.calls[3]
    expect(rmCall[1]).toContain('rm')
  })

  it('uses custom port and image', async () => {
    const exec: ExecFn = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === '--version') return { stdout: 'podman version 5.0', stderr: '' }
      if (args[0] === 'inspect') throw new Error('No such container')
      return { stdout: 'container-id', stderr: '' }
    })
    const connect = makeConnectFn(true)

    const info = await startLocalPg({
      execFn: exec,
      connectFn: connect,
      port: 15432,
      image: 'postgres:15',
    })

    expect(info.port).toBe(15432)
    expect(info.url).toContain('localhost:15432')
    const runCall = (exec as ReturnType<typeof vi.fn>).mock.calls[2]
    expect(runCall[1]).toContain('postgres:15')
    expect(runCall[1]).toContain('15432:5432')
  })

  it('throws on container start failure', async () => {
    const exec: ExecFn = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === '--version') return { stdout: 'podman version 5.0', stderr: '' }
      if (args[0] === 'inspect') throw new Error('No such container')
      if (args[0] === 'run') throw new Error('port already in use')
      return { stdout: '', stderr: '' }
    })

    await expect(
      startLocalPg({ execFn: exec, connectFn: makeConnectFn() }),
    ).rejects.toThrow('Failed to start PostgreSQL container via podman: port already in use')
  })
})

// ─── stopLocalPg ─────────────────────────────────────────────────────────────

describe('stopLocalPg', () => {
  it('removes container by name', async () => {
    const exec = makeExecFn(['podman'])
    await stopLocalPg('podman', CONTAINER_NAME, exec)

    const rmCall = (exec as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: string[]) => c[1]?.[0] === 'rm',
    )
    expect(rmCall).toBeTruthy()
    expect(rmCall[1]).toContain(CONTAINER_NAME)
  })

  it('does nothing when no runtime is available', async () => {
    const exec = makeExecFn([])
    await stopLocalPg(undefined, CONTAINER_NAME, exec)
    // Should only try to detect runtime (2 calls for podman + docker)
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('ignores errors when container does not exist', async () => {
    const exec: ExecFn = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'rm') throw new Error('No such container')
      return { stdout: '', stderr: '' }
    })
    // Should not throw
    await stopLocalPg('podman', 'nonexistent', exec)
  })
})
