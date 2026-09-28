import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { ContinuableStartSpec } from '@deepseek-ai/dsh-subagent'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { RlmKernel } from '@deepseek-ai/dsh-rlm-kernel'
import type { RlmHostRequestHandlers, RlmKernelHandle } from '@deepseek-ai/dsh-rlm-kernel'
import { apply, inject, name } from '../src/index.ts'

function agent(id: string, options: Agent['options'] = {}): Agent {
  const session = Session.create(SessionId(id), [], {
    version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 0, cwd: '/repo', isSeeded: false,
  })
  return {
    id: SessionId(id),
    options,
    session,
    inbox: unsupportedInbox(),
    ctx: new Context(),
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

class StubKernel extends RlmKernel {
  activeRegistrations = 0
  handlers: RlmHostRequestHandlers = {}

  acquire = (): Promise<RlmKernelHandle> => Promise.reject(new Error('no kernel'))
  release = (): Promise<void> => Promise.resolve()

  override registerHostRequestHandlers(handlers: RlmHostRequestHandlers): () => void {
    this.handlers = handlers
    this.activeRegistrations += 1
    const withdraw = super.registerHostRequestHandlers(handlers)
    return () => {
      this.activeRegistrations -= 1
      withdraw()
    }
  }
}

const EXPECTED_TYPES = [
  'rlm.run',
  'rlm.create_session',
  'rlm.find_models',
  'rlm.list_subagents',
  'rlm.collect',
  'rlm.progress.note',
  'rlm.delete_subagent',
  'bash.completed',
  'bash.consumed',
  'goal.get',
  'goal.create',
  'goal.complete',
  'compact.run',
  'compact.status',
  'model.info',
  'mcp.config',
  'mcp.refresh',
  'agent_message.list_agents',
  'agent_message.send',
  'agent_observe.list',
  'agent_observe.get',
  'agent_observe.recent',
  'rlm_heartbeat.list',
  'rlm_heartbeat.create',
  'rlm_heartbeat.update',
  'rlm_heartbeat.delete',
  'refine.run',
  'refine.status',
]

async function setup(config?: Parameters<typeof apply>[1], agentsStub?: Record<string, unknown>) {
  const ctx = new Context()
  await ctx.plugin(StubKernel)
  const kernel = ctx.rlmKernel as StubKernel
  const starts: ContinuableStartSpec[] = []
  ctx.provide('subagents', {
    startContinuable: (spec: ContinuableStartSpec) => {
      starts.push(spec)
      return Promise.resolve({ childId: SessionId('kid-1'), messageId: MessageId('m') })
    },
    listChildren: () => Promise.resolve([]),
    drainContinuableChildren: () => Promise.resolve(),
  } as never)
  ctx.provide('llm', {
    listProviders: () => [],
    listModels: () => Promise.resolve([]),
  } as never)
  ctx.provide('sessionQuery', {
    observeSession: () => Promise.resolve({ events: [], [Symbol.dispose]: () => {} }),
  } as never)
  ctx.provide('agents', agentsStub ?? {
    get: () => undefined,
    roots: () => [],
  } as never)
  ctx.provide('goals', {
    get: () => undefined,
  } as never)
  ctx.provide('compaction', {
    compactNow: () => Promise.resolve(null),
  } as never)
  ctx.provide('tokenMeter', {
    measure: () => ({ totalTokens: 0 }),
  } as never)
  apply(ctx, config)
  return { ctx, kernel, starts }
}


/** One persisted overdue heartbeat row for the scheduler startup tests. */
function overdueJob(sessionId: string): Record<string, unknown> {
  return {
    id: `hb-${sessionId}`,
    sessionId,
    status: 'active',
    deliveryMode: 'steer',
    instruction: 'beat',
    schedule: { kind: 'interval', expression: 'every 10s', intervalMs: 10_000 },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    nextRunAt: new Date(0).toISOString(),
    runCount: 0,
  }
}

/** Write one heartbeat store file below a fresh temporary DSH home. */
function seedHeartbeatStore(dshHome: string, contents: string): string {
  mkdirSync(join(dshHome, 'rlm'), { recursive: true })
  const file = join(dshHome, 'rlm', 'heartbeats.json')
  writeFileSync(file, contents, 'utf8')
  return file
}

/** Wait for one condition with a bounded poll. */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition was not met within one second')
}


/** Read the scheduled flag of one compact.status reply. */
async function compactScheduled(kernel: StubKernel, owner: Agent): Promise<boolean> {
  const status = await kernel.handlers['compact.status']!(
    { event: 'host_request', id: '2', data: { type: 'compact.status' } },
    { agent: owner, signal: new AbortController().signal },
  )
  if (status.status !== 'ok') throw new Error('expected an ok reply')
  return (status.result as { scheduled: boolean }).scheduled
}

/** Wait until one session's scheduled compaction has drained. */
async function waitForCompactionDrain(kernel: StubKernel, owner: Agent): Promise<void> {
  for (let attempt = 0; attempt < 100 && (await compactScheduled(kernel, owner)); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(await compactScheduled(kernel, owner)).toBe(false)
}

describe('rlm-bindings plugin', () => {
  it('names itself and declares its service dependencies', () => {
    expect(name).toBe('rlm-bindings')
    expect(inject).toEqual(['rlmKernel', 'subagents', 'llm', 'sessionQuery', 'agents', 'goals', 'tokenMeter'])
  })

  it('registers every host handler and withdraws them on dispose', async () => {
    const { ctx, kernel } = await setup()
    expect(Object.keys(kernel.handlers).sort()).toEqual([...EXPECTED_TYPES].sort())
    expect(kernel.activeRegistrations).toBe(1)
    await ctx.fiber.dispose()
    expect(kernel.activeRegistrations).toBe(0)
  })

  it('spawns through the configured provider and reports the default home paths', async () => {
    const { kernel, starts } = await setup()
    const reply = await kernel.handlers['rlm.run']!(
      { event: 'host_request', id: '1', data: { type: 'rlm.run', prompt: 'x', kwargs: { name: 'alpha' } } },
      { agent: agent('parent-1', { provider: 'p0', model: 'm0' }), signal: new AbortController().signal },
    )
    expect(starts[0]?.provider).toBe('spawn')
    expect(reply).toEqual({
      status: 'ok',
      result: {
        rlm_child_id: 'kid-1',
        name: 'alpha',
        session_dir: join(resolveDshHome(), 'rlm', 'children', 'kid-1'),
        model: 'p0/m0',
      },
    })
  })

  it('honors a custom provider name and dsh home', async () => {
    const { kernel, starts } = await setup({ providerName: 'custom-spawn', dshHome: '/tmp/rlm-bindings-test' })
    const reply = await kernel.handlers['rlm.run']!(
      { event: 'host_request', id: '1', data: { type: 'rlm.run', prompt: 'x', kwargs: { name: 'alpha' } } },
      { agent: agent('parent-1', { provider: 'p0', model: 'm0' }), signal: new AbortController().signal },
    )
    expect(starts[0]?.provider).toBe('custom-spawn')
    expect(reply).toEqual({
      status: 'ok',
      result: {
        rlm_child_id: 'kid-1',
        name: 'alpha',
        session_dir: '/tmp/rlm-bindings-test/rlm/children/kid-1',
        model: 'p0/m0',
      },
    })
  })

  it('treats a whitespace dsh home as unset', async () => {
    const { kernel } = await setup({ dshHome: '   ' })
    const reply = await kernel.handlers['rlm.run']!(
      { event: 'host_request', id: '1', data: { type: 'rlm.run', prompt: 'x', kwargs: { name: 'alpha' } } },
      { agent: agent('parent-1', { provider: 'p0', model: 'm0' }), signal: new AbortController().signal },
    )
    expect(reply.status).toBe('ok')
    if (reply.status !== 'ok') throw new Error('expected an ok reply')
    const dir = (reply.result as { session_dir: string }).session_dir
    expect(dir).toBe(join(resolveDshHome(), 'rlm', 'children', 'kid-1'))
  })

  it('steers a scheduled refinement at the turn boundary', async () => {
    const { ctx, kernel } = await setup()
    const running = agent('parent-1')
    const steered: unknown[] = []
    ;(running as { steer: (message: unknown) => void }).steer = (message) => { steered.push(message) }
    Object.defineProperty(running, 'status', { value: 'running' })
    const reply = await kernel.handlers['refine.run']!(
      { event: 'host_request', id: '1', data: { type: 'refine.run' } },
      { agent: running, signal: new AbortController().signal },
    )
    expect(reply).toEqual({
      status: 'ok',
      result: {
        scheduled: true,
        note: 'Refinement runs when the current turn ends; the request is then steered into your context '
          + 'as a refinement notice and you resume automatically. Continue working normally.',
      },
    })
    ctx.emit('agent/turn-stopping', { agent: running, turn: 1, signal: new AbortController().signal })
    expect(steered).toHaveLength(1)
  })

  it('forgets refinement state and cancels heartbeats when an agent disposes', async () => {
    const dshHome = `/tmp/rlm-bindings-test-disposed-${Math.random().toString(36).slice(2)}`
    const { ctx, kernel } = await setup({ dshHome })
    const owner = agent('parent-1')
    const created = await kernel.handlers['rlm_heartbeat.create']!(
      { event: 'host_request', id: '1', data: { type: 'rlm_heartbeat.create', instruction: 'beat' } },
      { agent: owner, signal: new AbortController().signal },
    )
    expect(created.status).toBe('ok')
    ctx.emit('agent/disposed', { agent: owner })
    const listed = await kernel.handlers['rlm_heartbeat.list']!(
      { event: 'host_request', id: '2', data: { type: 'rlm_heartbeat.list', include_inactive: true } },
      { agent: owner, signal: new AbortController().signal },
    )
    expect(listed.status).toBe('ok')
    if (listed.status !== 'ok') throw new Error('expected an ok reply')
    const rows = (listed.result as { heartbeats: { status: string }[] }).heartbeats
    expect(rows.map(row => row.status)).toEqual(['cancelled'])
    await ctx.fiber.dispose()
  })

  it('delivers overdue heartbeats to live sessions and records skips for dead ones', async () => {
    const dshHome = `/tmp/rlm-bindings-test-overdue-${Math.random().toString(36).slice(2)}`
    const file = seedHeartbeatStore(dshHome, JSON.stringify({ jobs: [overdueJob('live-1'), overdueJob('dead-1')] }))
    const live = agent('live-1')
    const steered: unknown[] = []
    ;(live as { steer: (message: unknown) => void }).steer = (message) => { steered.push(message) }
    const { ctx } = await setup({ dshHome }, {
      get: (id: unknown) => (String(id) === 'live-1' ? live : undefined),
      roots: () => [],
    })
    await waitFor(() => {
      const jobs = (JSON.parse(readFileSync(file, 'utf8')) as { jobs: { sessionId: string; runCount: number }[] }).jobs
      return jobs.find(job => job.sessionId === 'live-1')!.runCount === 1
    })
    const jobs = (JSON.parse(readFileSync(file, 'utf8')) as {
      jobs: { sessionId: string; runCount: number; lastError?: string }[]
    }).jobs
    expect(jobs.find(job => job.sessionId === 'dead-1')?.lastError).toContain('not live')
    expect(steered).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('runs a scheduled compaction through the agent-scoped engine once idle', async () => {
    const running = agent('parent-1')
    Object.defineProperty(running, 'status', { value: 'running' })
    const compacted: string[] = []
    running.ctx.provide('compaction', {
      compactNow: () => {
        compacted.push('ran')
        return Promise.resolve(null)
      },
    } as never)
    const { ctx, kernel } = await setup({}, {
      get: (id: unknown) => (String(id) === 'parent-1' ? running : undefined),
      roots: () => [],
    })
    const reply = await kernel.handlers['compact.run']!(
      { event: 'host_request', id: '1', data: { type: 'compact.run' } },
      { agent: running, signal: new AbortController().signal },
    )
    expect(reply.status).toBe('ok')
    if (reply.status !== 'ok') throw new Error('expected an ok reply')
    expect((reply.result as { scheduled: boolean }).scheduled).toBe(true)
    await waitFor(() => compacted.length === 1)
    await ctx.fiber.dispose()
  })

  it('resolves the compaction engine through the preset registry behind an isolate realm', async () => {
    const running = agent('parent-1')
    Object.defineProperty(running, 'status', { value: 'running' })
    const compacted: string[] = []
    const { ctx, kernel } = await setup({}, {
      get: (id: unknown) => (String(id) === 'parent-1' ? running : undefined),
      roots: () => [],
    })
    ctx.provide('agentPresets', {
      serviceFor: () => ({
        compactNow: () => {
          compacted.push('ran')
          return Promise.resolve(null)
        },
      }),
    } as never)
    const reply = await kernel.handlers['compact.run']!(
      { event: 'host_request', id: '1', data: { type: 'compact.run' } },
      { agent: running, signal: new AbortController().signal },
    )
    expect(reply.status).toBe('ok')
    await waitFor(() => compacted.length === 1)
    await ctx.fiber.dispose()
  })

  it('drops a scheduled compaction when the calling agent is no longer live', async () => {
    const running = agent('parent-1')
    Object.defineProperty(running, 'status', { value: 'running' })
    const { ctx, kernel } = await setup()
    const reply = await kernel.handlers['compact.run']!(
      { event: 'host_request', id: '1', data: { type: 'compact.run' } },
      { agent: running, signal: new AbortController().signal },
    )
    expect(reply.status).toBe('ok')
    await waitForCompactionDrain(kernel, running)
    await ctx.fiber.dispose()
  })

  it('drops a scheduled compaction when the agent scope mounts no engine', async () => {
    const running = agent('parent-1')
    Object.defineProperty(running, 'status', { value: 'running' })
    const { ctx, kernel } = await setup({}, {
      get: (id: unknown) => (String(id) === 'parent-1' ? running : undefined),
      roots: () => [],
    })
    const reply = await kernel.handlers['compact.run']!(
      { event: 'host_request', id: '1', data: { type: 'compact.run' } },
      { agent: running, signal: new AbortController().signal },
    )
    expect(reply.status).toBe('ok')
    await waitForCompactionDrain(kernel, running)
    await ctx.fiber.dispose()
  })

  it('reports a corrupt heartbeat store through the error sink instead of throwing', async () => {
    const dshHome = `/tmp/rlm-bindings-test-corrupt-${Math.random().toString(36).slice(2)}`
    seedHeartbeatStore(dshHome, 'not json')
    const { ctx, kernel } = await setup({ dshHome })
    expect(() => kernel.handlers['rlm_heartbeat.list']!(
      { event: 'host_request', id: '1', data: { type: 'rlm_heartbeat.list' } },
      { agent: agent('s1'), signal: new AbortController().signal },
    )).toThrow('corrupt')
    await ctx.fiber.dispose()
  })
})
