/**
 * Mocked-subprocess lifecycle suite. A fake `spawn` lets these specs drive
 * startup failures, publication races, orphan frames, forced teardown, and
 * rejected host handlers without depending on a real CPython. The
 * real-interpreter e2e suite lives in kernel.spec.ts.
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { RlmKernelError } from '@deepseek-ai/dsh-rlm-kernel'
import type { RlmHostRequestHandlers } from '@deepseek-ai/dsh-rlm-kernel'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, spawn: spawnMock }
})

import { PythonRlmKernel } from '../src/index.ts'

/** Options that bend one fake child away from the default three-pipe shape. */
interface FakeOptions {
  /** Set when the child has no stdin pipe at all. */
  readonly noStdin?: boolean
  /** Set when every post-bootstrap stdin write must fail, as a closed pipe does. */
  readonly writeFailure?: unknown
  /** Set when the child has no stdout pipe at all. */
  readonly noStdout?: boolean
  /** Status the bootstrap cell settles with; `error-silent` settles error without an error event. */
  readonly bootstrapStatus?: 'ok' | 'error' | 'error-silent'
}

/** A `child_process.ChildProcess` stand-in wired to `PassThrough` pipes. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = new PassThrough()
  readonly written: string[] = []
  readonly signals: string[] = []

  constructor(options: FakeOptions = {}) {
    super()
    if (options.noStdin === true) {
      Object.defineProperty(this, 'stdin', { value: null })
      return
    }
    if (options.noStdout === true) {
      Object.defineProperty(this, 'stdout', { value: null })
      return
    }
    const pipe = this.stdin
    const write = pipe.write.bind(pipe)
    pipe.write = ((chunk: Uint8Array | string) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      // The startup bootstrap must complete for acquire to resolve, so only
      // later writes bend to a refusal.
      if ('writeFailure' in options && !text.includes('_rlm_bootstrap')) throw options.writeFailure
      this.written.push(text)
      if (text.includes('_rlm_bootstrap')) {
        // Answer the bootstrap cell with the configured status; the frame id is reserved.
        const status = options.bootstrapStatus ?? 'ok'
        setImmediate(() => {
          if (status === 'error') {
            this.emitEvent({ event: 'error', id: '0', ename: 'RuntimeError', evalue: 'bootstrap exploded', traceback: [] })
          }
          this.emitEvent({ event: 'done', id: '0', status: status === 'error-silent' ? 'error' : status })
        })
      }
      return write(chunk)
    }) as typeof pipe.write
  }

  kill(signal?: string): boolean {
    this.signals.push(signal ?? 'SIGTERM')
    setImmediate(() => { this.emit('close', null, signal ?? 'SIGTERM') })
    return true
  }

  /** Write one event frame on the child's stdout. */
  emitEvent(object: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(object)}\n`)
  }

  /** Announce the startup handshake. */
  announce(): void {
    this.emitEvent({ event: 'ready', protocol: 3, python: '3.13.11' })
  }

  /** End the child, as an interpreter exit does. */
  exit(): void {
    this.stdout.end()
    this.emit('close', 0, null)
  }
}

/** Let queued microtasks and timers settle. */
function tick(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** Install one fake child as the next `spawn` result. */
function useChild(options: FakeOptions = {}): FakeChild {
  const child = new FakeChild(options)
  spawnMock.mockImplementation(() => child)
  return child
}

/** Mount the provider and hand back a child that has already announced itself. */
async function started(config: Record<string, unknown> = {}): Promise<{
  ctx: Context
  service: PythonRlmKernel
  handle: Awaited<ReturnType<PythonRlmKernel['acquire']>>
  child: FakeChild
}> {
  const child = useChild()
  const ctx = new Context()
  await ctx.plugin(PythonRlmKernel, { pythonBin: 'python3', shutdownGraceMs: 10, ...config })
  const service = ctx.get('rlmKernel') as PythonRlmKernel
  const acquiring = service.acquire(agent('s1'))
  await Promise.resolve()
  child.announce()
  const handle = await acquiring
  return { ctx, service, handle, child }
}

/** The spawn options of the most recent `spawn` call. */
function spawnOptions(): { env?: Record<string, string> } {
  return spawnMock.mock.calls[0]?.[2] as { env?: Record<string, string> }
}

function agent(id: string): Agent {
  return { id: brandString<SessionId>(id) } as Agent
}

afterEach(() => {
  spawnMock.mockReset()
})

describe('PythonRlmKernel load gate', () => {
  it('rejects a non-positive startup deadline', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(PythonRlmKernel, { pythonBin: 'python3', startupTimeoutMs: 0 }))
      .rejects.toThrow('startupTimeoutMs must be positive')
  })

  it('rejects a non-positive shutdown grace period', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(PythonRlmKernel, { pythonBin: 'python3', shutdownGraceMs: -1 }))
      .rejects.toThrow('shutdownGraceMs must be positive')
  })
})

describe('PythonRlmKernel startup', () => {
  it('spawns the runtime with the configured search path', async () => {
    const { ctx, handle } = await started({ pythonPath: ['/extra/py'] })
    expect(spawnMock.mock.calls[0]?.[0]).toBe('python3')
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(['-u', '-m', 'rlm.repl'])
    expect(spawnOptions().env?.PYTHONPATH?.split(':')).toContain('/extra/py')
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('drops an empty search-path entry', async () => {
    const { ctx, handle } = await started({ pythonPath: [''] })
    expect(spawnOptions().env?.PYTHONPATH?.split(':')).not.toContain('')
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('rejects a handshake that never arrives', async () => {
    useChild()
    const ctx = new Context()
    await ctx.plugin(PythonRlmKernel, { pythonBin: 'python3', startupTimeoutMs: 20 })
    const service = ctx.get('rlmKernel') as PythonRlmKernel
    await expect(service.acquire(agent('s1'))).rejects.toThrow('startup handshake timed out after 20ms')
    await ctx.fiber.dispose()
  })

  it('rejects a child with no stdout pipe', async () => {
    useChild({ noStdout: true })
    const ctx = new Context()
    await ctx.plugin(PythonRlmKernel, { pythonBin: 'python3' })
    const service = ctx.get('rlmKernel') as PythonRlmKernel
    await expect(service.acquire(agent('s1'))).rejects.toThrow('interpreter has no stdout pipe')
    await ctx.fiber.dispose()
  })

  it('ignores a repeated handshake', async () => {
    const { ctx, handle, child } = await started()
    child.announce()
    child.announce()
    const running = handle.execute('1 + 1')
    await Promise.resolve()
    child.emitEvent({ event: 'done', id: '1', status: 'ok' })
    await expect(running).resolves.toMatchObject({ status: 'ok' })
    await ctx.fiber.dispose()
  })

  it('rejects a non-error failure from the interpreter launch', async () => {
    spawnMock.mockImplementation(() => { throw 'spawn refused' })
    const ctx = new Context()
    await ctx.plugin(PythonRlmKernel, { pythonBin: 'python3', shutdownGraceMs: 10 })
    const service = ctx.get('rlmKernel') as PythonRlmKernel
    await expect(service.acquire(agent('s1'))).rejects.toThrow('rlm-kernel-python: startup failed')
    await ctx.fiber.dispose()
  })

  it('keeps a newer entry when an older startup fails', async () => {
    const first = useChild()
    const ctx = new Context()
    await ctx.plugin(PythonRlmKernel, { pythonBin: 'python3', startupTimeoutMs: 30, shutdownGraceMs: 10 })
    const service = ctx.get('rlmKernel') as PythonRlmKernel
    const stale = service.acquire(agent('s1'))
    await Promise.resolve()
    ctx.emit('agent/disposed', { agent: agent('s1') })
    await expect(stale).rejects.toThrow(RlmKernelError)
    const second = useChild()
    const reacquiring = service.acquire(agent('s1'))
    await Promise.resolve()
    second.announce()
    await expect(reacquiring).resolves.toMatchObject({ sessionId: 's1' })
    expect(first.signals).toContain('SIGKILL')
    await ctx.fiber.dispose()
  })

  it('rejects a child that fails to spawn and forgets the failed entry', async () => {
    const first = useChild()
    const ctx = new Context()
    await ctx.plugin(PythonRlmKernel, { pythonBin: 'python3', shutdownGraceMs: 10 })
    const service = ctx.get('rlmKernel') as PythonRlmKernel
    const acquiring = service.acquire(agent('s1'))
    await Promise.resolve()
    first.emit('error', new Error('ENOENT: spawn python3'))
    first.exit()
    await expect(acquiring).rejects.toThrow('ENOENT: spawn python3')
    const second = useChild()
    const retrying = service.acquire(agent('s1'))
    await Promise.resolve()
    second.announce()
    await expect(retrying).resolves.toMatchObject({ sessionId: 's1' })
    await ctx.fiber.dispose()
  })

  it('reports the child stderr when the interpreter exits before the handshake', async () => {
    const child = useChild()
    const ctx = new Context()
    await ctx.plugin(PythonRlmKernel, { pythonBin: 'python3' })
    const service = ctx.get('rlmKernel') as PythonRlmKernel
    const acquiring = service.acquire(agent('s1'))
    await Promise.resolve()
    child.stderr.write(Buffer.from('ModuleNotFoundError: No module named rlm'))
    child.exit()
    await expect(acquiring).rejects.toThrow('interpreter exited before the handshake: ModuleNotFoundError')
    await ctx.fiber.dispose()
  })
})

describe('PythonRlmKernel event routing', () => {
  it('drops every line that is not a valid event', async () => {
    const { ctx, handle, child } = await started()
    const running = handle.execute('1 + 1')
    await Promise.resolve()
    child.stdout.write('not json\n')
    child.emitEvent({ event: 'nonsense' })
    child.emitEvent({ event: 'stdout', id: '1', text: 'hi\n' })
    child.emitEvent({ event: 'done', id: '1', status: 'ok' })
    await expect(running).resolves.toMatchObject({ status: 'ok', stdout: 'hi\n' })
    await ctx.fiber.dispose()
  })

  it('ignores stream frames while a maintenance request is in flight', async () => {
    const { ctx, handle, child } = await started()
    const listing = handle.listNames()
    await Promise.resolve()
    child.emitEvent({ event: 'stdout', id: '1', text: 'stray\n' })
    child.emitEvent({ event: 'display', id: '1', data: { 'text/plain': 'stray' } })
    child.emitEvent({ event: 'result', id: '1', text: 'stray' })
    child.emitEvent({ event: 'done', id: '1', status: 'ok', names: ['alpha'] })
    await expect(listing).resolves.toEqual(['alpha'])
    await ctx.fiber.dispose()
  })

  it('ignores a done event for an unknown request', async () => {
    const { ctx, handle, child } = await started()
    const running = handle.execute('1 + 1')
    await Promise.resolve()
    child.emitEvent({ event: 'done', id: '99', status: 'ok' })
    child.emitEvent({ event: 'done', id: '1', status: 'ok' })
    await expect(running).resolves.toMatchObject({ status: 'ok' })
    await ctx.fiber.dispose()
  })

  it('keeps unattributed frames and prepends them to the next cell', async () => {
    const { ctx, handle, child } = await started()
    child.emitEvent({ event: 'stdout', id: null, text: 'orphan out\n' })
    child.emitEvent({ event: 'stderr', id: '9', text: 'orphan err\n' })
    child.emitEvent({ event: 'display', id: null, data: { 'text/plain': 'orphan display' } })
    child.emitEvent({ event: 'error', id: '9', ename: 'ValueError', evalue: 'boom', traceback: [] })
    const running = handle.execute('1 + 1')
    await Promise.resolve()
    child.emitEvent({ event: 'stdout', id: '1', text: 'mine\n' })
    child.emitEvent({ event: 'done', id: '1', status: 'ok' })
    const result = await running
    expect(result.stdout).toBe('orphan out\nmine\n')
    expect(result.stderr).toBe('orphan err\n')
    expect(result.display).toEqual([{ event: 'display', id: null, data: { 'text/plain': 'orphan display' } }])
    const second = handle.execute('2 + 2')
    await Promise.resolve()
    child.emitEvent({ event: 'done', id: '2', status: 'ok' })
    await expect(second).resolves.toMatchObject({ stdout: '', stderr: '', display: [] })
    await ctx.fiber.dispose()
  })

  it('delivers only the frames the running cell owns', async () => {
    const { ctx, handle, child } = await started()
    const seen: string[] = []
    const running = handle.execute('1 + 1', { onEvent: (event) => { seen.push(event.event) } })
    await Promise.resolve()
    child.emitEvent({ event: 'stdout', id: '1', text: 'a\n' })
    child.emitEvent({ event: 'result', id: '2', text: 'other' })
    child.emitEvent({ event: 'result', id: '1', text: '2' })
    child.emitEvent({ event: 'display', id: '2', data: { 'text/plain': 'other' } })
    child.emitEvent({ event: 'done', id: '1', status: 'ok' })
    const result = await running
    expect(seen).toEqual(['stdout', 'result', 'done'])
    expect(result.stdout).toBe('a\n')
    expect(result.representation).toBe('2')
    expect(result.display).toEqual([{ event: 'display', id: '2', data: { 'text/plain': 'other' } }])
    await ctx.fiber.dispose()
  })
})

describe('PythonRlmKernel maintenance requests', () => {
  it('reports a failing snapshot', async () => {
    const { ctx, handle, child } = await started()
    const snapshotting = handle.snapshot({ path: '/tmp/state.dill', manifest_path: '/tmp/state.json' })
    await Promise.resolve()
    child.emitEvent({ event: 'done', id: '1', status: 'error' })
    await expect(snapshotting).rejects.toThrow('rlm-kernel-python: snapshot failed: unknown reason')
    await ctx.fiber.dispose()
  })

  it('reports a snapshot with no per-name detail', async () => {
    const { ctx, handle, child } = await started()
    const snapshotting = handle.snapshot({ path: '/tmp/state.dill', manifest_path: '/tmp/state.json' })
    await Promise.resolve()
    child.emitEvent({ event: 'done', id: '1', status: 'ok' })
    await expect(snapshotting).resolves.toEqual({ saved: [], skipped: [], pruned: [], bytes: 0 })
    await ctx.fiber.dispose()
  })

  it('reports a restore with no per-name detail', async () => {
    const { ctx, handle, child } = await started()
    const restoring = handle.restore('/tmp/state.dill')
    await Promise.resolve()
    child.emitEvent({ event: 'done', id: '1', status: 'ok' })
    await expect(restoring).resolves.toEqual({ restored: [], failed: [] })
    await ctx.fiber.dispose()
  })

  it('reports a failing restore', async () => {
    const { ctx, handle, child } = await started()
    const restoring = handle.restore('/tmp/state.dill')
    await Promise.resolve()
    child.emitEvent({ event: 'done', id: '1', status: 'error', reason: 'dill unavailable: No module named dill' })
    await expect(restoring).rejects.toThrow('rlm-kernel-python: restore failed: dill unavailable')
    await ctx.fiber.dispose()
  })

  it('reports a snapshot with its caps applied', async () => {
    const { ctx, handle, child } = await started()
    const snapshotting = handle.snapshot({
      path: '/tmp/state.dill',
      manifest_path: '/tmp/state.json',
      max_bytes: 1024,
      max_variable_bytes: 512,
      prune_oversized: false,
    })
    await Promise.resolve()
    child.emitEvent({ event: 'done', id: '1', status: 'ok', saved: ['a'], skipped: ['b'], pruned: ['c'], bytes: 99 })
    await expect(snapshotting).resolves.toEqual({ saved: ['a'], skipped: ['b'], pruned: ['c'], bytes: 99 })
    await ctx.fiber.dispose()
  })

  it('reports a restore with and without a reason, and a bare name list', async () => {
    const { ctx, handle, child } = await started()
    const missing = handle.restore('/tmp/nothing.dill')
    await Promise.resolve()
    child.emitEvent({ event: 'done', id: '1', status: 'ok', restored: [], failed: [], reason: 'snapshot not found' })
    await expect(missing).resolves.toEqual({ restored: [], failed: [], reason: 'snapshot not found' })
    const revived = handle.restore('/tmp/state.dill')
    await Promise.resolve()
    child.emitEvent({ event: 'done', id: '2', status: 'ok', restored: ['secret'], failed: [] })
    await expect(revived).resolves.toEqual({ restored: ['secret'], failed: [] })
    const listing = handle.listNames()
    await Promise.resolve()
    child.emitEvent({ event: 'done', id: '3', status: 'ok' })
    await expect(listing).resolves.toEqual([])
    await ctx.fiber.dispose()
  })

  it('reports a non-error failure to submit a maintenance request', async () => {
    const child = useChild({ writeFailure: 'refused with a bare string' })
    const ctx = new Context()
    await ctx.plugin(PythonRlmKernel, { pythonBin: 'python3', shutdownGraceMs: 10 })
    const service = ctx.get('rlmKernel') as PythonRlmKernel
    const acquiring = service.acquire(agent('s1'))
    await Promise.resolve()
    child.announce()
    const handle = await acquiring
    // The pipe refuses the write with a value that is not an Error.
    await expect(handle.listNames()).rejects.toThrow('request could not be submitted')
    await ctx.fiber.dispose()
  })

  it('rejects maintenance work on a kernel that stopped', async () => {
    const { ctx, handle, child } = await started()
    child.exit()
    await tick(20)
    await expect(handle.snapshot({ path: '/tmp/s.dill', manifest_path: '/tmp/s.json' }))
      .rejects.toThrow(RlmKernelError)
    expect(() => { handle.interrupt() }).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('rejects startup with no writable stdin', async () => {
    const child = useChild({ noStdin: true })
    const ctx = new Context()
    await ctx.plugin(PythonRlmKernel, { pythonBin: 'python3', shutdownGraceMs: 10 })
    const service = ctx.get('rlmKernel') as PythonRlmKernel
    const acquiring = service.acquire(agent('s1'))
    await Promise.resolve()
    child.announce()
    await expect(acquiring).rejects.toThrow('kernel has no writable stdin')
    await ctx.fiber.dispose()
  })

  it('fails startup when the bootstrap cell raises', async () => {
    const child = useChild({ bootstrapStatus: 'error' })
    const ctx = new Context()
    await ctx.plugin(PythonRlmKernel, { pythonBin: 'python3', shutdownGraceMs: 10 })
    const service = ctx.get('rlmKernel') as PythonRlmKernel
    const acquiring = service.acquire(agent('s1'))
    await Promise.resolve()
    child.announce()
    await expect(acquiring).rejects.toThrow('rlm-kernel-python: runtime bootstrap failed: bootstrap exploded')
    expect(child.signals).toEqual(['SIGKILL'])
    await ctx.fiber.dispose()
  })

  it('fails startup on a bootstrap done error without detail events', async () => {
    const child = useChild({ bootstrapStatus: 'error-silent' })
    const ctx = new Context()
    await ctx.plugin(PythonRlmKernel, { pythonBin: 'python3', shutdownGraceMs: 10 })
    const service = ctx.get('rlmKernel') as PythonRlmKernel
    const acquiring = service.acquire(agent('s1'))
    await Promise.resolve()
    child.announce()
    await expect(acquiring).rejects.toThrow('rlm-kernel-python: runtime bootstrap failed:')
    await ctx.fiber.dispose()
  })
})

describe('PythonRlmKernel host requests', () => {
  /** Emit one host request and wait for the provider's reply. */
  async function oneHostRequest(
    data: Record<string, unknown>,
    handlers: RlmHostRequestHandlers,
  ): Promise<string> {
    const child = useChild()
    const ctx = new Context()
    await ctx.plugin(PythonRlmKernel, { pythonBin: 'python3' })
    const service = ctx.get('rlmKernel') as PythonRlmKernel
    const acquiring = service.acquire(agent('s1'), { hostRequests: handlers })
    await Promise.resolve()
    child.announce()
    const handle = await acquiring
    const running = handle.execute('1 + 1')
    await Promise.resolve()
    child.emitEvent({ event: 'host_request', id: 'h1', data })
    await tick(5)
    child.emitEvent({ event: 'done', id: '1', status: 'ok' })
    await running
    await ctx.fiber.dispose()
    return child.written.join('')
  }

  it('answers a request whose payload carries no type', async () => {
    const written = await oneHostRequest({ other: 'x' }, {})
    expect(written).toContain('"type":"host_reply","id":"h1"')
    expect(written).toContain('no host handler for')
  })

  it('reports a handler that rejects', async () => {
    const written = await oneHostRequest({ type: 'model.info' }, {
      'model.info': () => Promise.reject(new Error('provider down')),
    })
    expect(written).toContain('provider down')
  })

  it('reports a handler that rejects with a non-error', async () => {
    const written = await oneHostRequest({ type: 'model.info' }, {
      // A host handler may reject with anything; the kernel stringifies it.
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors
      'model.info': () => Promise.reject('plain string'),
    })
    expect(written).toContain('plain string')
  })
})

describe('PythonRlmKernel abort forwarding', () => {
  it('interrupts before submitting an already-aborted cell', async () => {
    const { ctx, handle, child } = await started()
    const controller = new AbortController()
    controller.abort()
    const running = handle.execute('1 + 1', { signal: controller.signal })
    await Promise.resolve()
    expect(child.written.join('')).toContain('"type":"interrupt"')
    child.emitEvent({ event: 'done', id: '1', status: 'error' })
    await running
    await ctx.fiber.dispose()
  })

  it('retires the pending entry when both writes are refused', async () => {
    const child = useChild({ writeFailure: 'refused with a bare string' })
    const ctx = new Context()
    await ctx.plugin(PythonRlmKernel, { pythonBin: 'python3', shutdownGraceMs: 10 })
    const service = ctx.get('rlmKernel') as PythonRlmKernel
    const acquiring = service.acquire(agent('s1'))
    await Promise.resolve()
    child.announce()
    const handle = await acquiring
    const controller = new AbortController()
    controller.abort()
    await expect(handle.execute('1 + 1', { signal: controller.signal }))
      .rejects.toThrow('request could not be submitted')
    await ctx.fiber.dispose()
  })

  it('swallows an interrupt raised after the kernel stopped', async () => {
    const { ctx, handle, child } = await started()
    const controller = new AbortController()
    const running = handle.execute('1 + 1', { signal: controller.signal })
    await Promise.resolve()
    child.exit()
    await expect(running).rejects.toThrow(RlmKernelError)
    controller.abort()
    await ctx.fiber.dispose()
  })
})

describe('PythonRlmKernel teardown', () => {
  it('ignores a repeated dispose', async () => {
    const { ctx, handle, child } = await started()
    await expect(handle.dispose()).resolves.toBeUndefined()
    await expect(handle.dispose()).resolves.toBeUndefined()
    expect(child.signals).toEqual(['SIGKILL'])
    expect(child.written.join('')).toContain('"type":"shutdown"')
    await ctx.fiber.dispose()
  })

  it('force-kills a child that ignores shutdown', async () => {
    const { ctx, handle, child } = await started({ shutdownGraceMs: 10 })
    await handle.dispose()
    expect(child.signals).toEqual(['SIGKILL'])
    await ctx.fiber.dispose()
  })

  it('bounds teardown when stdin rejects the shutdown write', async () => {
    const child = useChild({ writeFailure: Object.assign(new Error('EPIPE: broken pipe, write'), { code: 'EPIPE' }) })
    const ctx = new Context()
    await ctx.plugin(PythonRlmKernel, { pythonBin: 'python3', shutdownGraceMs: 10 })
    const service = ctx.get('rlmKernel') as PythonRlmKernel
    const acquiring = service.acquire(agent('s1'))
    await Promise.resolve()
    child.announce()
    const handle = await acquiring
    await expect(handle.dispose()).resolves.toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('fails an in-flight cell when the kernel is disposed', async () => {
    const { ctx, handle } = await started()
    const running = handle.execute('1 + 1')
    await Promise.resolve()
    const disposing = handle.dispose()
    await expect(running).rejects.toThrow('kernel was disposed')
    await disposing
    await ctx.fiber.dispose()
  })

  it('stops the kernel when the owning session is disposed', async () => {
    const child = useChild()
    const ctx = new Context()
    await ctx.plugin(PythonRlmKernel, { pythonBin: 'python3', shutdownGraceMs: 10 })
    const service = ctx.get('rlmKernel') as PythonRlmKernel
    const acquiring = service.acquire(agent('s9'))
    await Promise.resolve()
    child.announce()
    await acquiring
    ctx.emit('agent/disposed', { agent: agent('unrelated') })
    await tick(5)
    expect(child.signals).toEqual([])
    ctx.emit('agent/disposed', { agent: agent('s9') })
    await tick(50)
    expect(child.signals).toContain('SIGKILL')
    await ctx.fiber.dispose()
  })

  it('stops every kernel when the composition unloads', async () => {
    const first = useChild()
    const ctx = new Context()
    await ctx.plugin(PythonRlmKernel, { pythonBin: 'python3' })
    const service = ctx.get('rlmKernel') as PythonRlmKernel
    const acquiringFirst = service.acquire(agent('s1'))
    await Promise.resolve()
    first.announce()
    await acquiringFirst
    const second = useChild()
    const acquiringSecond = service.acquire(agent('s2'))
    await Promise.resolve()
    second.announce()
    await acquiringSecond
    await ctx.fiber.dispose()
    expect(first.signals).toContain('SIGKILL')
    expect(second.signals).toContain('SIGKILL')
  })

  it('starts a fresh kernel after a handle is disposed', async () => {
    const { ctx, service } = await started({ shutdownGraceMs: 10 })
    await service.release('s1' as SessionId)
    const second = useChild()
    const reacquiring = service.acquire(agent('s1'))
    await Promise.resolve()
    second.announce()
    await expect(reacquiring).resolves.toMatchObject({ sessionId: 's1' })
    await ctx.fiber.dispose()
  })
})
