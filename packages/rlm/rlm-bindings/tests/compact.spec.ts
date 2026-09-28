import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { RlmHostReplyData, RlmHostRequestContext, RlmHostRequestEvent } from '@deepseek-ai/dsh-rlm-kernel'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { createCompactHostHandlers } from '../src/compact.ts'
import type {
  CompactBackend,
  CompactBindingDeps,
  CompactModelCatalog,
  CompactUsageSource,
  CompactionAgent,
} from '../src/compact.ts'

interface AgentControl {
  status: 'idle' | 'running'
  idle: () => Promise<void>
}

function agent(id: string, options: Agent['options'] = {}, control?: Partial<AgentControl>): { owner: Agent; control: AgentControl } {
  const session = Session.create(SessionId(id), [], {
    version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 0, cwd: '/repo', isSeeded: false,
  })
  const state: AgentControl = { status: 'idle', idle: () => Promise.resolve(), ...control }
  const owner: Agent = {
    id: SessionId(id),
    options,
    session,
    inbox: unsupportedInbox(),
    ctx: new Context(),
    get status() { return state.status },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => state.idle(),
  }
  return { owner, control: state }
}

function request(data: RlmHostRequestEvent['data']): RlmHostRequestEvent {
  return { event: 'host_request', id: '1', data }
}

function contextFor(owner: Agent, signal = new AbortController().signal): RlmHostRequestContext {
  return { agent: owner, signal }
}

/** Unwrap an ok reply, failing the test on an error reply. */
function okResult(reply: RlmHostReplyData): JsonValue {
  if (reply.status !== 'ok') throw new Error('expected an ok reply')
  return reply.result
}

/** Invoke a handler so a synchronous validation throw surfaces as a rejection. */
async function call(
  handler: (request: RlmHostRequestEvent, context: RlmHostRequestContext) => Promise<unknown>,
  req: RlmHostRequestEvent,
  ctx: RlmHostRequestContext,
): Promise<unknown> {
  return handler(req, ctx)
}

class FakeCompaction implements CompactBackend {
  readonly calls: { agent: CompactionAgent; signal: AbortSignal }[] = []
  failure: Error | undefined

  compactNow(agent: CompactionAgent, signal: AbortSignal): Promise<unknown> {
    if (this.failure !== undefined) return Promise.reject(this.failure)
    this.calls.push({ agent, signal })
    return Promise.resolve(null)
  }
}

class FakeUsage implements CompactUsageSource {
  tokens: number | undefined = 1000

  measure(): { totalTokens: number } {
    if (this.tokens === undefined) throw new Error('no measurement')
    return { totalTokens: this.tokens }
  }
}

class FakeModels implements CompactModelCatalog {
  window: number | undefined = 2000
  failure: Error | undefined

  resolveModelInfo(): Promise<{ context?: { contextWindow: number } }> {
    if (this.failure !== undefined) return Promise.reject(this.failure)
    return Promise.resolve(this.window === undefined ? {} : { context: { contextWindow: this.window } })
  }
}

function deps(overrides: Partial<CompactBindingDeps> = {}): CompactBindingDeps {
  return {
    compaction: new FakeCompaction(),
    usage: new FakeUsage(),
    models: new FakeModels(),
    ...overrides,
  }
}

/** An idle gate that suspends the first whenIdle call until released. */
function idleGate(): { idle: () => Promise<void>; release: () => void } {
  let calls = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  return {
    idle: () => {
      calls += 1
      return calls === 1 ? gate : Promise.resolve()
    },
    release: () => { release() },
  }
}

describe('compact.run', () => {
  it('rejects a non-string instructions member', async () => {
    const handlers = createCompactHostHandlers(deps())
    const running = agent('s2', {}, { status: 'running' })
    await expect(call(
      handlers['compact.run']!,
      request({ type: 'compact.run', instructions: 42 }),
      contextFor(running.owner),
    )).rejects.toThrow('compact.run instructions must be a string when provided')
  })

  it('declines to schedule when the agent has no active turn', async () => {
    const handlers = createCompactHostHandlers(deps())
    const { owner } = agent('s1')
    const reply = await handlers['compact.run']!(request({ type: 'compact.run' }), contextFor(owner))
    expect(reply).toEqual({
      status: 'ok',
      result: {
        scheduled: false,
        reason: 'no active turn; compaction can only be requested while a turn is running',
      },
    })
  })

  it('schedules compaction and runs it once the agent settles to idle', async () => {
    const compaction = new FakeCompaction()
    const handlers = createCompactHostHandlers(deps({ compaction }))
    const gate = idleGate()
    const { owner } = agent('s1', { provider: 'p1', model: 'm1' }, { status: 'running', idle: gate.idle })
    const signal = new AbortController().signal
    const reply = await handlers['compact.run']!(
      request({ type: 'compact.run', instructions: 'focus on the migration' }),
      { agent: owner, signal },
    )
    expect(okResult(reply)).toEqual({
      scheduled: true,
      note: 'Compaction runs when the current turn ends; the summary replaces older history. Continue working normally.',
    })
    expect(compaction.calls).toHaveLength(0)
    gate.release()
    await vi.waitFor(() => { expect(compaction.calls).toHaveLength(1) })
    expect(compaction.calls[0]!.agent).toBe(owner)
    expect(compaction.calls[0]!.signal).toBe(signal)
    const status = await handlers['compact.status']!(request({ type: 'compact.status' }), contextFor(owner))
    expect(okResult(status)).toEqual({ tokens: 1000, context_window: 2000, percent: 50, scheduled: false })
  })

  it('keeps a single drain when compaction is requested twice in one turn', async () => {
    const compaction = new FakeCompaction()
    const handlers = createCompactHostHandlers(deps({ compaction }))
    const gate = idleGate()
    const { owner } = agent('s1', {}, { status: 'running', idle: gate.idle })
    const context = contextFor(owner)
    const first = await handlers['compact.run']!(request({ type: 'compact.run' }), context)
    const second = await handlers['compact.run']!(
      request({ type: 'compact.run', instructions: 'newer instructions' }),
      context,
    )
    expect(okResult(first)).toMatchObject({ scheduled: true })
    expect(okResult(second)).toMatchObject({ scheduled: true })
    gate.release()
    await vi.waitFor(() => { expect(compaction.calls).toHaveLength(1) })
    await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
    expect(compaction.calls).toHaveLength(1)
  })

  it('swallows a failed compaction and accepts a later request', async () => {
    const compaction = new FakeCompaction()
    compaction.failure = new Error('busy')
    const handlers = createCompactHostHandlers(deps({ compaction }))
    const gate = idleGate()
    const { owner, control } = agent('s1', {}, { status: 'running', idle: gate.idle })
    const context = contextFor(owner)
    const reply = await handlers['compact.run']!(request({ type: 'compact.run' }), context)
    expect(okResult(reply)).toMatchObject({ scheduled: true })
    gate.release()
    await vi.waitFor(async () => {
      const status = okResult(await handlers['compact.status']!(request({ type: 'compact.status' }), context))
      expect(status).toMatchObject({ scheduled: false })
    })
    compaction.failure = undefined
    control.idle = () => Promise.resolve()
    const again = await handlers['compact.run']!(request({ type: 'compact.run' }), context)
    expect(okResult(again)).toMatchObject({ scheduled: true })
    await vi.waitFor(() => { expect(compaction.calls).toHaveLength(1) })
  })

  it('drops the pending request when the idle wait rejects', async () => {
    const compaction = new FakeCompaction()
    const handlers = createCompactHostHandlers(deps({ compaction }))
    const { owner } = agent('s1', {}, {
      status: 'running',
      idle: () => Promise.reject(new Error('kernel disposed')),
    })
    const context = contextFor(owner)
    const reply = await handlers['compact.run']!(request({ type: 'compact.run' }), context)
    expect(okResult(reply)).toMatchObject({ scheduled: true })
    await vi.waitFor(async () => {
      const status = okResult(await handlers['compact.status']!(request({ type: 'compact.status' }), context))
      expect(status).toMatchObject({ scheduled: false })
    })
    expect(compaction.calls).toHaveLength(0)
  })
})

describe('compact.status', () => {
  it('reports pressure, capacity, and percent of the calling agent route', async () => {
    const handlers = createCompactHostHandlers(deps())
    const { owner } = agent('s1', { provider: 'p1', model: 'm1' })
    const reply = await handlers['compact.status']!(request({ type: 'compact.status' }), contextFor(owner))
    expect(okResult(reply)).toEqual({ tokens: 1000, context_window: 2000, percent: 50, scheduled: false })
  })

  it('reports a scheduled compaction', async () => {
    const handlers = createCompactHostHandlers(deps())
    const gate = idleGate()
    const { owner } = agent('s1', { provider: 'p1', model: 'm1' }, { status: 'running', idle: gate.idle })
    const context = contextFor(owner)
    await handlers['compact.run']!(request({ type: 'compact.run' }), context)
    const reply = await handlers['compact.status']!(request({ type: 'compact.status' }), context)
    expect(okResult(reply)).toEqual({ tokens: 1000, context_window: 2000, percent: 50, scheduled: true })
    gate.release()
  })

  it('reports null tokens when the meter cannot measure', async () => {
    const usage = new FakeUsage()
    usage.tokens = undefined
    const handlers = createCompactHostHandlers(deps({ usage }))
    const { owner } = agent('s1', { provider: 'p1', model: 'm1' })
    const reply = await handlers['compact.status']!(request({ type: 'compact.status' }), contextFor(owner))
    expect(okResult(reply)).toEqual({ tokens: null, context_window: 2000, percent: null, scheduled: false })
  })

  it('reports null capacity when the route cannot be resolved', async () => {
    const models = new FakeModels()
    models.failure = new Error('unknown provider')
    const handlers = createCompactHostHandlers(deps({ models }))
    const { owner } = agent('s1', { provider: 'p1', model: 'm1' })
    const reply = await handlers['compact.status']!(request({ type: 'compact.status' }), contextFor(owner))
    expect(okResult(reply)).toEqual({ tokens: 1000, context_window: null, percent: null, scheduled: false })
  })

  it('reports null capacity when the agent has no route', async () => {
    const handlers = createCompactHostHandlers(deps())
    const { owner } = agent('s1')
    const reply = await handlers['compact.status']!(request({ type: 'compact.status' }), contextFor(owner))
    expect(okResult(reply)).toEqual({ tokens: 1000, context_window: null, percent: null, scheduled: false })
  })

  it('reports null capacity when only the provider is set', async () => {
    const handlers = createCompactHostHandlers(deps())
    const { owner } = agent('s1', { provider: 'p1' })
    const reply = await handlers['compact.status']!(request({ type: 'compact.status' }), contextFor(owner))
    expect(okResult(reply)).toEqual({ tokens: 1000, context_window: null, percent: null, scheduled: false })
  })

  it('reports null capacity when the adapter declares no context', async () => {
    const models = new FakeModels()
    models.window = undefined
    const handlers = createCompactHostHandlers(deps({ models }))
    const { owner } = agent('s1', { provider: 'p1', model: 'm1' })
    const reply = await handlers['compact.status']!(request({ type: 'compact.status' }), contextFor(owner))
    expect(okResult(reply)).toEqual({ tokens: 1000, context_window: null, percent: null, scheduled: false })
  })

  it('treats a non-positive context window as unknown', async () => {
    const models = new FakeModels()
    models.window = 0
    const handlers = createCompactHostHandlers(deps({ models }))
    const { owner } = agent('s1', { provider: 'p1', model: 'm1' })
    const reply = await handlers['compact.status']!(request({ type: 'compact.status' }), contextFor(owner))
    expect(okResult(reply)).toEqual({ tokens: 1000, context_window: null, percent: null, scheduled: false })
  })
})
