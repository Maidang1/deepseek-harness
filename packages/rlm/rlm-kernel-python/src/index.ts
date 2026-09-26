/**
 * Service Provider for the `ctx.rlmKernel` capability seam: one persistent
 * CPython subprocess per agent session. The child runs `python -m rlm.repl`
 * from the `py/` directory this package ships, so the runtime travels with the
 * plugin instead of requiring a pre-installed Python distribution.
 *
 * Cells execute in one namespace that survives across turns, model code can
 * `await` at top level, and an `interrupt` raises `KeyboardInterrupt` inside
 * the running cell without killing the interpreter. Model code holds
 * shell-equivalent trust: the provider contains runaway work through output
 * caps and a shutdown deadline, but the child is not a security boundary.
 *
 * @module @deepseek-ai/dsh-rlm-kernel-python
 */

import { spawn, type ChildProcess } from 'node:child_process'
import type { Writable } from 'node:stream'
import { createInterface } from 'node:readline'
import { delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  encodeRlmRequest,
  parseRlmEvent,
  RlmKernel,
  RlmKernelError,
} from '@deepseek-ai/dsh-rlm-kernel'
import type {
  RlmCellError,
  RlmCellResult,
  RlmDisplayEvent,
  RlmDoneEvent,
  RlmErrorEvent,
  RlmExecuteOptions,
  RlmHostReplyData,
  RlmHostRequestEvent,
  RlmKernelAcquireOptions,
  RlmKernelHandle,
  RlmHostRequestHandlers,
  RlmOutputEvent,
  RlmResultEvent,
  RlmRestoreResult,
  RlmSnapshotRequest,
  RlmSnapshotResult,
  RlmWireEvent,
} from '@deepseek-ai/dsh-rlm-kernel'
import { resolvePythonInterpreter } from './python.ts'

/** Default per-channel capture cap in characters. */
const DEFAULT_MAX_OUTPUT_CHARS = 65_536

/** Default ceiling on the startup handshake in milliseconds. */
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000

/** Default grace period between `shutdown` and SIGKILL in milliseconds. */
const DEFAULT_SHUTDOWN_GRACE_MS = 3_000

/** Cap on stderr bytes retained for a startup diagnosis. */
const STDERR_DIAGNOSTIC_CHARS = 4_096

/** Validated plugin configuration; every cap is changeable from `cordis.yml`. */
export interface Config {
  /** CPython command: an absolute path or a bare name resolved through `PATH`. */
  pythonBin: Volatile<string>
  /** Extra directories on the child interpreter's module search path. */
  pythonPath: Volatile<readonly string[]>
  /** Per-channel capture cap in characters. */
  maxOutputChars: Volatile<number>
  /** Ceiling on the startup handshake in milliseconds. */
  startupTimeoutMs: Volatile<number>
  /** Grace period between `shutdown` and SIGKILL in milliseconds. */
  shutdownGraceMs: Volatile<number>
}

/** One request awaiting its `done` event. */
interface PendingRequest {
  readonly id: string
  readonly kind: 'execute' | 'snapshot' | 'restore' | 'list_names'
  readonly startedAt: number
  readonly onEvent?: (event: RlmWireEvent) => void
  stdout: string
  stderr: string
  display: RlmDisplayEvent[]
  representation?: string
  error?: RlmCellError
  settle(value: unknown): void
  fail(error: Error): void
}

/** One live interpreter and the state the reader loop shares with its callers. */
interface KernelEntry {
  readonly agent: Agent
  readonly hostRequests: RlmHostRequestHandlers
  handle: RlmKernelHandle | undefined
  child: ChildProcess | undefined
  stdin: Writable | undefined
  pending: Map<string, PendingRequest>
  orphanStdout: string
  orphanStderr: string
  orphanDisplay: RlmDisplayEvent[]
  ready: Promise<void>
  releaseReady: () => void
  rejectReady: (error: Error) => void
  readySettled: boolean
  dead: Error | undefined
  disposed: boolean
  nextId: number
}

/** Absolute directory of the `py/` tree this package ships. */
function pythonSourceDir(): string {
  return fileURLToPath(new URL('../py/', import.meta.url))
}

/** Whether the configuration can start a kernel at all. */
function assertServiceableConfig(config: Config): void {
  if (config.pythonBin.get().trim() === '') {
    throw new Error('rlm-kernel-python: pythonBin must not be empty')
  }
  if (config.maxOutputChars.get() <= 0) {
    throw new Error('rlm-kernel-python: maxOutputChars must be positive')
  }
  if (config.startupTimeoutMs.get() <= 0) {
    throw new Error('rlm-kernel-python: startupTimeoutMs must be positive')
  }
  if (config.shutdownGraceMs.get() <= 0) {
    throw new Error('rlm-kernel-python: shutdownGraceMs must be positive')
  }
}

/** Append captured text under a per-channel character cap. */
function appendCapped(current: string, text: string, cap: number): string {
  const merged = `${current}${text}`
  return merged.length > cap ? merged.slice(merged.length - cap) : merged
}

/** CPython kernel provider registering itself as `ctx.rlmKernel`. */
export class PythonRlmKernel extends RlmKernel {
  static Config = z.object({
    pythonBin: z.string().default('python3').volatile(),
    pythonPath: z.array(z.string()).default([]).volatile(),
    maxOutputChars: z.number().default(DEFAULT_MAX_OUTPUT_CHARS).volatile(),
    startupTimeoutMs: z.number().default(DEFAULT_STARTUP_TIMEOUT_MS).volatile(),
    shutdownGraceMs: z.number().default(DEFAULT_SHUTDOWN_GRACE_MS).volatile(),
  })

  private readonly entries = new Map<SessionId, KernelEntry>()

  constructor(ctx: Context, readonly config: Config) {
    super(ctx)
    assertServiceableConfig(config)
    resolvePythonInterpreter(config.pythonBin.get())
    ctx.on('agent/disposed', ({ agent }) => {
      const entry = this.entries.get(agent.id)
      if (entry === undefined) return
      this.entries.delete(agent.id)
      void this.disposeEntry(entry)
    })
    ctx.effect(() => async () => {
      const entries = [...this.entries.values()]
      this.entries.clear()
      await Promise.all(entries.map(entry => this.disposeEntry(entry)))
    })
  }

  /**
   * The kernel handle for one session, starting the interpreter on first use.
   *
   * @param agent - the session-backed agent that owns the kernel.
   * @param options - host handlers and module search path applied at creation.
   * @returns the session's live kernel handle.
   */
  async acquire(agent: Agent, options?: RlmKernelAcquireOptions): Promise<RlmKernelHandle> {
    const existing = this.entries.get(agent.id)
    if (existing !== undefined && !existing.disposed && existing.dead === undefined) {
      existing.handle ??= this.createHandle(existing)
      return existing.handle
    }
    const entry = this.createEntry(agent, options?.hostRequests ?? {})
    this.entries.set(agent.id, entry)
    try {
      await this.start(entry, options?.pythonPath ?? [])
    } catch (error: unknown) {
      if (this.entries.get(agent.id) === entry) this.entries.delete(agent.id)
      await this.disposeEntry(entry)
      throw error instanceof Error ? error : new RlmKernelError('rlm-kernel-python: startup failed')
    }
    entry.handle ??= this.createHandle(entry)
    return entry.handle
  }

  /**
   * The handle over one live entry.
   *
   * @param entry - the kernel entry the handle drives.
   * @returns the handle the seam exposes to consumers.
   */
  private createHandle(entry: KernelEntry): RlmKernelHandle {
    return {
      sessionId: entry.agent.id,
      execute: (code, options) => this.runCell(entry, code, options),
      interrupt: () => {
        try {
          this.writeRequest(entry, { type: 'interrupt' })
        } catch {
          // The kernel already stopped; the in-flight cell settles from the exit.
        }
      },
      snapshot: request => this.runSnapshot(entry, request),
      restore: path => this.runRestore(entry, path),
      listNames: () => this.runListNames(entry),
      dispose: () => this.disposeEntry(entry),
    }
  }

  /**
   * Stop and forget the kernel a session owns, when it has one.
   *
   * @param sessionId - identity of the session whose kernel is released.
   */
  async release(sessionId: SessionId): Promise<void> {
    const entry = this.entries.get(sessionId)
    if (entry === undefined) return
    this.entries.delete(sessionId)
    await this.disposeEntry(entry)
  }

  private createEntry(agent: Agent, hostRequests: RlmHostRequestHandlers): KernelEntry {
    const handshake = Promise.withResolvers<void>()
    const ready = handshake.promise
    return {
      agent,
      hostRequests,
      handle: undefined,
      child: undefined,
      stdin: undefined,
      pending: new Map(),
      orphanStdout: '',
      orphanStderr: '',
      orphanDisplay: [],
      ready,
      releaseReady: handshake.resolve,
      rejectReady: handshake.reject,
      readySettled: false,
      dead: undefined,
      disposed: false,
      nextId: 1,
    }
  }

  private async start(entry: KernelEntry, extraPath: readonly string[]): Promise<void> {
    const interpreter = resolvePythonInterpreter(this.config.pythonBin.get())
    const searchPath = [pythonSourceDir(), ...this.config.pythonPath.get(), ...extraPath]
      .filter(directory => directory !== '')
      .join(delimiter)
    // Typed as the wide ChildProcess, not the stdio-tuple overload's narrow
    // stream shape: a kernel host may hand back a child with no pipes.
    const child: ChildProcess = spawn(interpreter.bin, ['-u', '-m', 'rlm.repl'], {
      env: { ...process.env, PYTHONPATH: searchPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    entry.child = child
    entry.stdin = child.stdin ?? undefined
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = chunk.toString('utf8').slice(-STDERR_DIAGNOSTIC_CHARS)
    })
    const closed = new Promise<void>((resolveClose) => { child.on('close', () => { resolveClose() }) })
    child.on('error', (error: Error) => { this.failEntry(entry, error) })
    void this.pump(entry, child, stderr)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        entry.ready,
        closed.then((): never => {
          throw new RlmKernelError(`rlm-kernel-python: interpreter exited before the handshake: ${stderr.trim()}`)
        }),
        new Promise<never>((_resolve, rejectTimeout) => {
          timer = setTimeout(() => {
            rejectTimeout(new RlmKernelError(`rlm-kernel-python: startup handshake timed out after ${String(this.config.startupTimeoutMs.get())}ms`))
          }, this.config.startupTimeoutMs.get())
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  private async pump(entry: KernelEntry, child: ChildProcess, stderr: string): Promise<void> {
    const stdout = child.stdout
    if (stdout === null) {
      this.failEntry(entry, new RlmKernelError('rlm-kernel-python: interpreter has no stdout pipe'))
      return
    }
    const lines = createInterface({ input: stdout })
    try {
      for await (const line of lines) this.route(entry, line)
    } catch {
      // A readline error ends the loop; the child close below settles the entry.
    }
    if (!entry.readySettled) {
      entry.readySettled = true
      entry.rejectReady(new RlmKernelError(`rlm-kernel-python: interpreter exited before the handshake: ${stderr.trim()}`))
    }
    this.failEntry(entry, new RlmKernelError(`rlm-kernel-python: interpreter exited: ${stderr.trim()}`))
  }

  private failEntry(entry: KernelEntry, error: Error): void {
    if (entry.dead !== undefined) return
    entry.dead = error
    if (!entry.readySettled) {
      entry.readySettled = true
      entry.rejectReady(error)
    }
    for (const pending of [...entry.pending.values()]) {
      entry.pending.delete(pending.id)
      pending.fail(error)
    }
  }

  private route(entry: KernelEntry, line: string): void {
    const event = parseRlmEvent(line)
    if (event === undefined) return
    if (event.event === 'ready') {
      if (!entry.readySettled) {
        entry.readySettled = true
        entry.releaseReady()
      }
      return
    }
    if (event.event === 'host_request') {
      void this.answer(entry, event)
      return
    }
    if (event.event === 'done') {
      this.settle(entry, event)
      return
    }
    this.collect(entry, event)
  }

  private collect(entry: KernelEntry, event: RlmOutputEvent | RlmResultEvent | RlmDisplayEvent | RlmErrorEvent): void {
    const active = this.activeExecute(entry)
    const mine = active !== undefined && (event.id === active.id || event.id === null)
    const owner = mine ? active : undefined
    const cap = this.config.maxOutputChars.get()
    switch (event.event) {
      case 'stdout':
      case 'stderr': {
        if (owner === undefined) {
          if (event.event === 'stdout') entry.orphanStdout = appendCapped(entry.orphanStdout, event.text, cap)
          else entry.orphanStderr = appendCapped(entry.orphanStderr, event.text, cap)
          return
        }
        owner[event.event] = appendCapped(owner[event.event], event.text, cap)
        owner.onEvent?.(event)
        return
      }
      case 'result': {
        if (owner === undefined) return
        owner.representation = event.text
        owner.onEvent?.(event)
        return
      }
      case 'display': {
        if (owner === undefined) entry.orphanDisplay.push(event)
        else {
          owner.display.push(event)
          owner.onEvent?.(event)
        }
        return
      }
      case 'error': {
        if (owner === undefined) return
        owner.error = { ename: event.ename, evalue: event.evalue, traceback: event.traceback }
        owner.onEvent?.(event)
      }
    }
  }

  private activeExecute(entry: KernelEntry): PendingRequest | undefined {
    for (const pending of entry.pending.values()) {
      if (pending.kind === 'execute') return pending
    }
    return undefined
  }

  private settle(entry: KernelEntry, event: RlmDoneEvent): void {
    const pending = entry.pending.get(event.id)
    if (pending === undefined) return
    entry.pending.delete(event.id)
    pending.onEvent?.(event)
    if (pending.kind !== 'execute') {
      this.settleMaintenance(pending, event)
      return
    }
    const result: RlmCellResult = {
      status: event.status,
      stdout: `${entry.orphanStdout}${pending.stdout}`,
      stderr: `${entry.orphanStderr}${pending.stderr}`,
      display: [...entry.orphanDisplay, ...pending.display],
      ...pending.representation === undefined ? {} : { representation: pending.representation },
      ...pending.error === undefined ? {} : { error: pending.error },
      durationMs: Date.now() - pending.startedAt,
    }
    entry.orphanStdout = ''
    entry.orphanStderr = ''
    entry.orphanDisplay = []
    pending.settle(result)
  }

  private settleMaintenance(pending: PendingRequest, event: RlmDoneEvent): void {
    if (event.status === 'error') {
      pending.fail(new RlmKernelError(`rlm-kernel-python: ${pending.kind} failed: ${event.reason ?? 'unknown reason'}`))
      return
    }
    if (pending.kind === 'snapshot') {
      const result: RlmSnapshotResult = {
        saved: event.saved ?? [],
        skipped: event.skipped ?? [],
        pruned: event.pruned ?? [],
        bytes: event.bytes ?? 0,
      }
      pending.settle(result)
      return
    }
    if (pending.kind === 'restore') {
      const result: RlmRestoreResult = { restored: event.restored ?? [], failed: event.failed ?? [] }
      pending.settle(event.reason === undefined ? result : { ...result, reason: event.reason })
      return
    }
    pending.settle(event.names ?? [])
  }

  /**
   * Write one request on the child's stdin, retiring its pending entry when the
   * pipe refuses it. A failed write settles the request here so the entry's
   * pending table never keeps a request no `done` event will ever answer.
   *
   * @param entry - the kernel entry the request belongs to.
   * @param request - the request to serialize.
   * @param id - identity of the pending entry the write serves.
   */
  private submit(entry: KernelEntry, request: object, id: string): void {
    try {
      this.writeRequest(entry, request)
    } catch (error: unknown) {
      const pending = entry.pending.get(id)
      if (pending === undefined) return
      entry.pending.delete(id)
      pending.fail(error instanceof Error ? error : new RlmKernelError('rlm-kernel-python: request could not be submitted'))
    }
  }

  private writeRequest(entry: KernelEntry, request: object): void {
    if (entry.disposed || entry.dead !== undefined) {
      throw new RlmKernelError('rlm-kernel-python: kernel is not running')
    }
    const stdin = entry.stdin
    if (stdin === undefined || stdin.writableEnded) {
      throw new RlmKernelError('rlm-kernel-python: kernel has no writable stdin')
    }
    stdin.write(encodeRlmRequest(request))
  }

  private async runCell(entry: KernelEntry, code: string, options?: RlmExecuteOptions): Promise<RlmCellResult> {
    this.assertLive(entry)
    const id = String(entry.nextId)
    entry.nextId += 1
    const settled = this.register<RlmCellResult>(entry, id, 'execute', options?.onEvent)
    if (options?.signal?.aborted === true) this.submit(entry, { type: 'interrupt' }, id)
    options?.signal?.addEventListener('abort', () => {
      try {
        this.writeRequest(entry, { type: 'interrupt' })
      } catch {
        // The kernel already stopped; the in-flight cell settles from the exit.
      }
    }, { once: true })
    this.submit(entry, { type: 'execute', id, code }, id)
    return settled
  }

  private async runSnapshot(entry: KernelEntry, request: Omit<RlmSnapshotRequest, 'type' | 'id'>): Promise<RlmSnapshotResult> {
    this.assertLive(entry)
    const id = String(entry.nextId)
    entry.nextId += 1
    const settled = this.register<RlmSnapshotResult>(entry, id, 'snapshot')
    this.submit(entry, {
      type: 'snapshot',
      id,
      path: request.path,
      manifest_path: request.manifest_path,
      ...request.max_bytes === undefined ? {} : { max_bytes: request.max_bytes },
      ...request.max_variable_bytes === undefined ? {} : { max_variable_bytes: request.max_variable_bytes },
      ...request.prune_oversized === undefined ? {} : { prune_oversized: request.prune_oversized },
    }, id)
    return settled
  }

  private async runRestore(entry: KernelEntry, path: string): Promise<RlmRestoreResult> {
    this.assertLive(entry)
    const id = String(entry.nextId)
    entry.nextId += 1
    const settled = this.register<RlmRestoreResult>(entry, id, 'restore')
    this.submit(entry, { type: 'restore', id, path }, id)
    return settled
  }

  private async runListNames(entry: KernelEntry): Promise<readonly string[]> {
    this.assertLive(entry)
    const id = String(entry.nextId)
    entry.nextId += 1
    const settled = this.register<readonly string[]>(entry, id, 'list_names')
    this.submit(entry, { type: 'list_names', id }, id)
    return settled
  }

  private assertLive(entry: KernelEntry): void {
    if (entry.disposed) throw new RlmKernelError('rlm-kernel-python: kernel is disposed')
    if (entry.dead !== undefined) throw entry.dead
  }

  private register<T>(
    entry: KernelEntry,
    id: string,
    kind: PendingRequest['kind'],
    onEvent?: (event: RlmWireEvent) => void,
  ): Promise<T> {
    return new Promise<T>((resolvePromise, rejectPromise) => {
      const pending: PendingRequest = {
        id,
        kind,
        startedAt: Date.now(),
        stdout: '',
        stderr: '',
        display: [],
        settle: (value: unknown) => { resolvePromise(value as T) },
        fail: (error: Error) => { rejectPromise(error) },
        ...onEvent === undefined ? {} : { onEvent },
      }
      entry.pending.set(id, pending)
    })
  }

  private async answer(entry: KernelEntry, event: RlmHostRequestEvent): Promise<void> {
    const type = hostRequestType(event)
    const handler = type === undefined ? undefined : this.hostRequestHandler(entry.hostRequests, type)
    const controller = new AbortController()
    let data: RlmHostReplyData
    if (handler === undefined) {
      data = { status: 'error', error: `rlm-kernel-python: no host handler for "${type ?? ''}"` }
    } else {
      try {
        data = await handler(event, { agent: entry.agent, signal: controller.signal })
      } catch (error: unknown) {
        data = { status: 'error', error: error instanceof Error ? error.message : String(error) }
      }
    }
    this.writeRequest(entry, { type: 'host_reply', id: event.id, data })
  }

  private async disposeEntry(entry: KernelEntry): Promise<void> {
    if (entry.disposed) return
    entry.disposed = true
    const child = entry.child
    entry.child = undefined
    entry.stdin = undefined
    for (const pending of [...entry.pending.values()]) {
      entry.pending.delete(pending.id)
      pending.fail(new RlmKernelError('rlm-kernel-python: kernel was disposed'))
    }
    if (child === undefined) return
    const exited = new Promise<void>((resolveExited) => { child.on('close', () => { resolveExited() }) })
    try {
      child.stdin?.write(encodeRlmRequest({ type: 'shutdown' }))
      child.stdin?.end()
    } catch {
      // The child already closed its stdin; the exit wait below still bounds teardown.
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([exited, new Promise<void>((resolveKill) => {
        timer = setTimeout(() => {
          child.kill('SIGKILL')
          resolveKill()
        }, this.config.shutdownGraceMs.get())
      })])
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * The `type` discriminator a host request carries.
 *
 * @param event - the host request event as the child sent it.
 * @returns the request type, or `undefined` when the payload carries none.
 */
function hostRequestType(event: RlmHostRequestEvent): string | undefined {
  const type: unknown = event.data.type
  return typeof type === 'string' ? type : undefined
}

export default PythonRlmKernel
