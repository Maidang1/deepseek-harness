import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  ContinuableStart,
  ContinuableStartSpec,
  SubagentCatalogEntry,
  SubagentTimingProjection,
} from '@deepseek-ai/dsh-subagent'
import type { RlmHostReplyData, RlmHostRequestContext, RlmHostRequestEvent } from '@deepseek-ai/dsh-rlm-kernel'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { Roster } from '../src/roster.ts'
import { createRlmHostHandlers } from '../src/subagents.ts'
import type { ChildObservation, ObservationSource, RlmBindingDeps, RlmCollectRow, RlmSubagentRow, SubagentBackend } from '../src/subagents.ts'
import type { ModelCatalog } from '../src/models.ts'

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

class FakeSubagents implements SubagentBackend {
  readonly starts: ContinuableStartSpec[] = []
  readonly drained: (readonly SessionId[])[] = []
  children: SubagentCatalogEntry[] = []
  failStart: Error | undefined
  private nextId = 0

  startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart> {
    if (this.failStart !== undefined) return Promise.reject(this.failStart)
    this.starts.push(spec)
    this.nextId += 1
    return Promise.resolve({ childId: spec.childId ?? SessionId(`child-${this.nextId}`), messageId: MessageId('m') })
  }

  listChildren(): Promise<SubagentCatalogEntry[]> {
    return Promise.resolve(this.children)
  }

  drainContinuableChildren(_parent: Agent, childIds: readonly SessionId[]): Promise<void> {
    this.drained.push(childIds)
    return Promise.resolve()
  }
}

interface Cut {
  readonly events: SessionEvent[]
  readonly timing?: SubagentTimingProjection
}

class FakeObservations implements ObservationSource {
  readonly cuts = new Map<string, Cut[]>()
  disposed = 0

  observeSession(sessionId: SessionId): Promise<ChildObservation & Disposable> {
    const queue = this.cuts.get(String(sessionId))
    const cut: Cut = queue === undefined || queue.length === 0
      ? { events: [] }
      : queue.length === 1
        ? queue[0]!
        : queue.shift()!
    return Promise.resolve({
      events: cut.events,
      ...cut.timing === undefined ? {} : { projections: { values: { subagentTiming: cut.timing } } },
      [Symbol.dispose]: () => { this.disposed += 1 },
    })
  }
}

const catalog: ModelCatalog = {
  listProviders: () => [{ id: 'p1', name: 'P1' }],
  listModels: () => Promise.resolve([{ provider: 'p1', id: 'm1', name: 'M1' }]),
}

function deps(overrides: Partial<RlmBindingDeps> = {}): RlmBindingDeps {
  return {
    subagents: new FakeSubagents(),
    models: catalog,
    observations: new FakeObservations(),
    roster: new Roster(),
    providerName: 'spawn',
    sessionDir: childId => `/sessions/${childId}`,
    ...overrides,
  }
}

function assistantMessage(text: string): AssistantMessage {
  return {
    id: MessageId('ma'),
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'p', model: 'm' },
  }
}

function userMessage(text: string): UserMessage {
  return { id: MessageId('mu'), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function turnStart(seq: number, time: number): SessionEvent {
  return { type: 'turn/start', seq: SessionSeq(seq), time, data: { turn: 1 } }
}

function turnEndCompleted(seq: number, time: number): SessionEvent {
  return { type: 'turn/end', seq: SessionSeq(seq), time, data: { turn: 1, reason: { kind: 'completed' } } }
}

function toolCall(seq: number, time: number): SessionEvent {
  return {
    type: 'tool/call',
    seq: SessionSeq(seq),
    time,
    data: { turn: 1, step: 0, callId: ToolCallId('c1'), name: 'bash', arguments: '{}' },
  }
}

function assistant(seq: number, time: number, text: string): SessionEvent {
  return {
    type: 'assistant/message',
    seq: SessionSeq(seq),
    time,
    data: { turn: 1, step: 0, message: assistantMessage(text), stream: [] },
    surfaceOp: 'append',
  }
}

function user(seq: number, time: number, text: string): SessionEvent {
  return { type: 'user/message', seq: SessionSeq(seq), time, data: userMessage(text), surfaceOp: 'append' }
}

function child(id: string, label?: string): SubagentCatalogEntry {
  return label === undefined
    ? { id: SessionId(id), createdAt: 0, mode: 'unknown' }
    : { id: SessionId(id), createdAt: 0, mode: 'continuable', label }
}

describe('rlm.run', () => {
  it('starts a continuable child with the requested route and admits it to the roster', async () => {
    const subagents = new FakeSubagents()
    const handlers = createRlmHostHandlers(deps({ subagents }))
    const owner = agent('parent-1')
    const signal = new AbortController().signal
    const reply = await handlers['rlm.run']!(
      request({ type: 'rlm.run', prompt: 'do it', kwargs: { name: 'alpha', model: 'p1/m1', thinking: 'high' } }),
      { agent: owner, signal },
    )
    expect(reply).toEqual({
      status: 'ok',
      result: { rlm_child_id: 'child-1', name: 'alpha', session_dir: '/sessions/child-1', model: 'p1/m1' },
    })
    const spec = subagents.starts[0]!
    expect(spec.provider).toBe('spawn')
    expect(spec.label).toBe('alpha')
    expect(spec.signal).toBe(signal)
    expect(spec.request.prompt).toEqual([{ type: 'text', text: 'do it' }])
    expect(spec.request.parent).toBe(owner)
    expect(spec.request.agentOptions).toEqual({ provider: 'p1', model: 'm1', reasoningEffort: 'high' })
  })

  it('inherits the parent route when no model is requested', async () => {
    const subagents = new FakeSubagents()
    const d = deps({ subagents })
    const handlers = createRlmHostHandlers(d)
    const reply = await handlers['rlm.run']!(
      request({ type: 'rlm.run', prompt: 'do it', kwargs: { name: 'beta' } }),
      contextFor(agent('parent-1', { provider: 'p0', model: 'm0' })),
    )
    expect(reply).toEqual({
      status: 'ok',
      result: { rlm_child_id: 'child-1', name: 'beta', session_dir: '/sessions/child-1', model: 'p0/m0' },
    })
    expect('agentOptions' in subagents.starts[0]!.request).toBe(false)
    expect(d.roster.entry('parent-1', 'child-1')).toMatchObject({ name: 'beta', model: 'p0/m0', label: 'do it' })
  })

  it('rejects a non-string prompt', async () => {
    const handlers = createRlmHostHandlers(deps())
    await expect(handlers['rlm.run']!(request({ type: 'rlm.run', prompt: 1 }), contextFor(agent('p'))))
      .rejects.toThrow('rlm.spawn prompt must be a string')
  })

  it('treats malformed kwargs as none and then requires the name', async () => {
    const handlers = createRlmHostHandlers(deps())
    await expect(
      handlers['rlm.run']!(request({ type: 'rlm.run', prompt: 'x', kwargs: 5 }), contextFor(agent('p'))),
    ).rejects.toThrow('rlm.spawn name is required')
  })

  it('rejects a selector without a provider split', async () => {
    const handlers = createRlmHostHandlers(deps())
    await expect(
      handlers['rlm.run']!(request({ type: 'rlm.run', prompt: 'x', kwargs: { name: 'n', model: 'plain' } }), contextFor(agent('p'))),
    ).rejects.toThrow('rlm.spawn model must use the form "provider/model-id"')
  })

  it('rejects when no model is requested and the parent has no route', async () => {
    const handlers = createRlmHostHandlers(deps())
    await expect(
      handlers['rlm.run']!(request({ type: 'rlm.run', prompt: 'x', kwargs: { name: 'n' } }), contextFor(agent('p'))),
    ).rejects.toThrow('rlm.spawn: no model was given and the parent session has no provider/model route to inherit')
  })

  it('rejects a sibling-duplicate name', async () => {
    const handlers = createRlmHostHandlers(deps())
    const owner = agent('parent-1', { provider: 'p0', model: 'm0' })
    await handlers['rlm.run']!(request({ type: 'rlm.run', prompt: 'x', kwargs: { name: 'alpha' } }), contextFor(owner))
    await expect(
      handlers['rlm.run']!(request({ type: 'rlm.run', prompt: 'y', kwargs: { name: 'alpha' } }), contextFor(owner)),
    ).rejects.toThrow('rlm.spawn name "alpha" is already used by a sibling in the current parent session')
  })

  it('releases the name reservation when the start fails', async () => {
    const subagents = new FakeSubagents()
    subagents.failStart = new Error('provider down')
    const handlers = createRlmHostHandlers(deps({ subagents }))
    const owner = agent('parent-1', { provider: 'p0', model: 'm0' })
    await expect(
      handlers['rlm.run']!(request({ type: 'rlm.run', prompt: 'x', kwargs: { name: 'alpha' } }), contextFor(owner)),
    ).rejects.toThrow('provider down')
    subagents.failStart = undefined
    const reply = await handlers['rlm.run']!(
      request({ type: 'rlm.run', prompt: 'x', kwargs: { name: 'alpha' } }),
      contextFor(owner),
    )
    expect(reply.status).toBe('ok')
  })
})

describe('rlm.create_session', () => {
  it('mints the child id and a default name up front', async () => {
    const subagents = new FakeSubagents()
    const handlers = createRlmHostHandlers(deps({ subagents }))
    const reply = await handlers['rlm.create_session']!(
      request({ type: 'rlm.create_session', prompt: 'research the topic', kwargs: {} }),
      contextFor(agent('parent-1', { provider: 'p0', model: 'm0' })),
    )
    const spec = subagents.starts[0]!
    const minted = String(spec.childId)
    expect(minted).not.toBe('undefined')
    const name = spec.label
    expect(name.startsWith('subagent-research-the-topic-')).toBe(true)
    expect(reply).toEqual({
      status: 'ok',
      result: {
        active_session_id: minted,
        session_id: minted,
        name,
        session_file: `/sessions/${minted}`,
        model: 'p0/m0',
      },
    })
  })

  it('honors an explicit name and rejects the cwd kwarg', async () => {
    const subagents = new FakeSubagents()
    const handlers = createRlmHostHandlers(deps({ subagents }))
    const reply = await handlers['rlm.create_session']!(
      request({ type: 'rlm.create_session', prompt: 'x', kwargs: { name: 'resident' } }),
      contextFor(agent('parent-1', { provider: 'p0', model: 'm0' })),
    )
    expect(reply.status).toBe('ok')
    expect(subagents.starts[0]!.label).toBe('resident')
    await expect(
      handlers['rlm.create_session']!(
        request({ type: 'rlm.create_session', prompt: 'x', kwargs: { cwd: '/tmp' } }),
        contextFor(agent('parent-1', { provider: 'p0', model: 'm0' })),
      ),
    ).rejects.toThrow('rlm.create_session: the cwd kwarg is not supported by this host')
  })
})

describe('rlm.find_models', () => {
  it('returns the catalog matches', async () => {
    const handlers = createRlmHostHandlers(deps())
    const reply = await handlers['rlm.find_models']!(
      request({ type: 'rlm.find_models', query: 'm1', limit: 5 }),
      contextFor(agent('p')),
    )
    expect(reply).toEqual({
      status: 'ok',
      result: { models: [{ provider: 'p1', id: 'm1', name: 'M1', selector: 'p1/m1' }] },
    })
  })
})

describe('rlm.list_subagents', () => {
  it('returns an empty registry for a childless parent', async () => {
    const handlers = createRlmHostHandlers(deps())
    const reply = await handlers['rlm.list_subagents']!(request({ type: 'rlm.list_subagents' }), contextFor(agent('p')))
    expect(reply).toEqual({ status: 'ok', result: { subagents: [] } })
  })

  it('projects roster, catalog, and folded facts onto rows', async () => {
    const subagents = new FakeSubagents()
    subagents.children = [child('c1', 'cat-one'), child('c2'), child('c3', 'cat-three')]
    const observations = new FakeObservations()
    observations.cuts.set('c1', [{
      events: [user(0, 100, 'do'), toolCall(1, 200), assistant(2, 300, 'done!')],
      timing: { settledMs: 42, lastTurnCompleted: true },
    }])
    observations.cuts.set('c3', [{
      events: [turnStart(0, 100), turnEndCompleted(1, 200)],
      timing: { settledMs: 100, lastTurnCompleted: false },
    }])
    const d = deps({ subagents, observations })
    d.roster.admit('parent-1', { childId: 'c1', name: 'alpha', model: 'p0/m0', label: 'lbl alpha', createdAt: 1 })
    d.roster.noteProgress('c1', 'note-1', 1)
    const handlers = createRlmHostHandlers(d)
    const reply = await handlers['rlm.list_subagents']!(
      request({ type: 'rlm.list_subagents' }),
      contextFor(agent('parent-1')),
    )
    expect(reply).toEqual({
      status: 'ok',
      result: {
        subagents: [
          {
            rlm_child_id: 'c1',
            active_session_id: 'c1',
            session_id: 'c1',
            session_name: 'alpha',
            session_dir: '/sessions/c1',
            status: 'completed',
            tool_use_count: 1,
            duration_ms: 42,
            answer_preview: 'done!',
            replied_since_task: true,
            progress_note: 'note-1',
            label: 'lbl alpha',
            last_activity_at: 300,
          },
          {
            rlm_child_id: 'c2',
            active_session_id: 'c2',
            session_id: 'c2',
            session_name: 'subagent-worker-c2',
            session_dir: '/sessions/c2',
            status: 'running',
            label: 'subagent-worker-c2',
          },
          {
            rlm_child_id: 'c3',
            active_session_id: 'c3',
            session_id: 'c3',
            session_name: 'cat-three',
            session_dir: '/sessions/c3',
            status: 'error',
            duration_ms: 100,
            last_activity_at: 200,
            label: 'cat-three',
          },
        ],
      },
    })
    expect(observations.disposed).toBe(3)
  })

  it('reports wall-clock staleness for a running child without roster stamps', async () => {
    const subagents = new FakeSubagents()
    subagents.children = [child('c3', 'old one')]
    const observations = new FakeObservations()
    const old = Date.now() - 700_000
    observations.cuts.set('c3', [{
      events: [turnStart(0, old)],
      timing: { settledMs: 0, active: { since: old, through: old + 5 } },
    }])
    const handlers = createRlmHostHandlers(deps({ subagents, observations }))
    const reply = await handlers['rlm.list_subagents']!(
      request({ type: 'rlm.list_subagents' }),
      contextFor(agent('parent-1')),
    )
    expect(reply.status).toBe('ok')
    const row = (okResult(reply) as { subagents: RlmSubagentRow[] }).subagents[0]!
    expect(row.status).toBe('running')
    expect(row.activity_stale_ms).toBeGreaterThanOrEqual(600_000)
    expect(row.duration_ms).toBe(5)
  })
})

describe('rlm.collect', () => {
  it('snapshots every child with a zero timeout', async () => {
    const subagents = new FakeSubagents()
    subagents.children = [child('c1', 'one'), child('c2', 'two'), child('c3', 'three')]
    const observations = new FakeObservations()
    observations.cuts.set('c1', [{
      events: [toolCall(0, 90), assistant(1, 100, 'answer one')],
      timing: { settledMs: 10, lastTurnCompleted: true },
    }])
    observations.cuts.set('c2', [{
      events: [turnStart(0, 100)],
      timing: { settledMs: 0, active: { since: 100, through: 150 } },
    }])
    const handlers = createRlmHostHandlers(deps({ subagents, observations }))
    const reply = await handlers['rlm.collect']!(
      request({ type: 'rlm.collect', targets: [], timeout_ms: 0 }),
      contextFor(agent('parent-1')),
    )
    expect(reply).toEqual({
      status: 'ok',
      result: {
        results: [
          {
            rlm_child_id: 'c1',
            session_name: 'one',
            session_dir: '/sessions/c1',
            status: 'done',
            settled: true,
            answer_preview: 'answer one',
            duration_ms: 10,
            tool_use_count: 1,
            replied_since_task: true,
          },
          {
            rlm_child_id: 'c2',
            session_name: 'two',
            session_dir: '/sessions/c2',
            status: 'running',
            settled: false,
            duration_ms: 50,
          },
          {
            rlm_child_id: 'c3',
            session_name: 'three',
            session_dir: '/sessions/c3',
            status: 'queued',
            settled: false,
          },
        ],
      },
    })
  })

  it('rejects an unmatched or ambiguous selector', async () => {
    const subagents = new FakeSubagents()
    subagents.children = [child('dup', 'x'), child('other', 'dup')]
    const handlers = createRlmHostHandlers(deps({ subagents }))
    await expect(
      handlers['rlm.collect']!(request({ type: 'rlm.collect', targets: ['zzz'] }), contextFor(agent('parent-1'))),
    ).rejects.toThrow('No direct RLM child matches "zzz" in the current parent session')
    await expect(
      handlers['rlm.collect']!(request({ type: 'rlm.collect', targets: ['dup'] }), contextFor(agent('parent-1'))),
    ).rejects.toThrow('RLM child selector "dup" is ambiguous in the current parent session')
  })

  it('waits for the selected children to settle', async () => {
    const subagents = new FakeSubagents()
    subagents.children = [child('c1', 'one')]
    const observations = new FakeObservations()
    observations.cuts.set('c1', [
      { events: [turnStart(0, 100)], timing: { settledMs: 0, active: { since: 100, through: 200 } } },
      { events: [turnStart(0, 100), turnEndCompleted(1, 300)], timing: { settledMs: 200, lastTurnCompleted: true } },
    ])
    const handlers = createRlmHostHandlers(deps({ subagents, observations }))
    const reply = await handlers['rlm.collect']!(
      request({ type: 'rlm.collect', targets: ['c1'], timeout_ms: 5000 }),
      contextFor(agent('parent-1')),
    )
    expect(reply.status).toBe('ok')
    const row = (okResult(reply) as { results: RlmCollectRow[] }).results[0]!
    expect(row.status).toBe('done')
    expect(row.settled).toBe(true)
  })

  it('returns the current snapshot when the wait times out', async () => {
    const subagents = new FakeSubagents()
    subagents.children = [child('c1', 'one')]
    const observations = new FakeObservations()
    observations.cuts.set('c1', [
      { events: [turnStart(0, 100)], timing: { settledMs: 0, active: { since: 100, through: 200 } } },
    ])
    const handlers = createRlmHostHandlers(deps({ subagents, observations }))
    const reply = await handlers['rlm.collect']!(
      request({ type: 'rlm.collect', targets: ['c1'], timeout_ms: 50 }),
      contextFor(agent('parent-1')),
    )
    const row = (okResult(reply) as { results: RlmCollectRow[] }).results[0]!
    expect(row.status).toBe('running')
    expect(row.settled).toBe(false)
  })

  it('stops waiting when the handle is disposed', async () => {
    const subagents = new FakeSubagents()
    subagents.children = [child('c1', 'one')]
    const observations = new FakeObservations()
    observations.cuts.set('c1', [
      { events: [turnStart(0, 100)], timing: { settledMs: 0, active: { since: 100, through: 200 } } },
    ])
    const handlers = createRlmHostHandlers(deps({ subagents, observations }))
    const controller = new AbortController()
    controller.abort()
    const reply = await handlers['rlm.collect']!(
      request({ type: 'rlm.collect', targets: ['c1'], timeout_ms: 5000 }),
      contextFor(agent('parent-1'), controller.signal),
    )
    const row = (okResult(reply) as { results: RlmCollectRow[] }).results[0]!
    expect(row.settled).toBe(false)
  })

  it('reports a failed child with its error text', async () => {
    const subagents = new FakeSubagents()
    subagents.children = [child('c1', 'one')]
    const observations = new FakeObservations()
    observations.cuts.set('c1', [{
      events: [turnStart(0, 100), { type: 'turn/end', seq: SessionSeq(1), time: 200, data: { turn: 1, reason: { kind: 'max-tokens' } } }],
      timing: { settledMs: 100, lastTurnCompleted: false },
    }])
    const handlers = createRlmHostHandlers(deps({ subagents, observations }))
    const reply = await handlers['rlm.collect']!(
      request({ type: 'rlm.collect', targets: ['c1'] }),
      contextFor(agent('parent-1')),
    )
    const row = (okResult(reply) as { results: RlmCollectRow[] }).results[0]!
    expect(row.status).toBe('error')
    expect(row.error).toBe('the turn hit the output token ceiling')
  })
})

/** Invoke a handler so a synchronous validation throw surfaces as a rejection. */
async function call(
  handler: (request: RlmHostRequestEvent, context: RlmHostRequestContext) => Promise<unknown>,
  req: RlmHostRequestEvent,
  ctx: RlmHostRequestContext,
): Promise<unknown> {
  return handler(req, ctx)
}

describe('rlm.progress.note', () => {
  it('accepts the first note and throttles the next', async () => {
    const d = deps()
    d.roster.admit('parent-1', { childId: 'c1', name: 'alpha', model: 'p/m', label: 'l', createdAt: 1 })
    const handlers = createRlmHostHandlers(d)
    const first = await handlers['rlm.progress.note']!(
      request({ type: 'rlm.progress.note', message: 'halfway' }),
      contextFor(agent('c1')),
    )
    expect(first).toEqual({ status: 'ok', result: { accepted: true } })
    const second = await handlers['rlm.progress.note']!(
      request({ type: 'rlm.progress.note', message: 'more' }),
      contextFor(agent('c1')),
    )
    expect(second.status).toBe('ok')
    const result = okResult(second) as { accepted: boolean; retry_after_ms?: number }
    expect(result.accepted).toBe(false)
    expect(result.retry_after_ms).toBeGreaterThan(0)
    expect(result.retry_after_ms).toBeLessThanOrEqual(10_000)
  })

  it('rejects a note from a session that is no RLM child', async () => {
    const handlers = createRlmHostHandlers(deps())
    await expect(
      call(handlers['rlm.progress.note']!, request({ type: 'rlm.progress.note', message: 'hi' }), contextFor(agent('stray'))),
    ).rejects.toThrow('rlm.progress.note: this session is not a registered RLM child')
  })
})

describe('rlm.delete_subagent', () => {
  function completedChild() {
    const subagents = new FakeSubagents()
    subagents.children = [child('c1', 'one')]
    const observations = new FakeObservations()
    observations.cuts.set('c1', [{
      events: [assistant(0, 100, 'done')],
      timing: { settledMs: 10, lastTurnCompleted: true },
    }])
    return { subagents, observations }
  }

  it('drains a settled child and forgets it', async () => {
    const { subagents, observations } = completedChild()
    const d = deps({ subagents, observations })
    d.roster.admit('parent-1', { childId: 'c1', name: 'alpha', model: 'p/m', label: 'l', createdAt: 1 })
    const handlers = createRlmHostHandlers(d)
    const reply = await handlers['rlm.delete_subagent']!(
      request({ type: 'rlm.delete_subagent', target: 'alpha' }),
      contextFor(agent('parent-1')),
    )
    expect(reply.status).toBe('ok')
    const result = okResult(reply) as { subagent: RlmSubagentRow }
    expect(result).not.toHaveProperty('outcome')
    expect(result.subagent.rlm_child_id).toBe('c1')
    expect(subagents.drained).toEqual([[SessionId('c1')]])
    expect(d.roster.entry('parent-1', 'c1')).toBeUndefined()
  })

  it('skips a running child and keeps it rostered', async () => {
    const subagents = new FakeSubagents()
    subagents.children = [child('c1', 'one')]
    const observations = new FakeObservations()
    observations.cuts.set('c1', [{
      events: [turnStart(0, 100)],
      timing: { settledMs: 0, active: { since: 100, through: 200 } },
    }])
    const d = deps({ subagents, observations })
    d.roster.admit('parent-1', { childId: 'c1', name: 'alpha', model: 'p/m', label: 'l', createdAt: 1 })
    const handlers = createRlmHostHandlers(d)
    const reply = await handlers['rlm.delete_subagent']!(
      request({ type: 'rlm.delete_subagent', target: 'c1' }),
      contextFor(agent('parent-1')),
    )
    const result = okResult(reply) as { outcome: string }
    expect(result.outcome).toBe('skipped_running')
    expect(subagents.drained).toEqual([])
    expect(d.roster.entry('parent-1', 'c1')).toBeDefined()
  })

  it('rejects an unmatched or ambiguous selector', async () => {
    const subagents = new FakeSubagents()
    subagents.children = [child('dup', 'x'), child('other', 'dup')]
    const handlers = createRlmHostHandlers(deps({ subagents }))
    await expect(
      handlers['rlm.delete_subagent']!(request({ type: 'rlm.delete_subagent', target: 'zzz' }), contextFor(agent('p'))),
    ).rejects.toThrow('No direct RLM subagent matches "zzz" in the current parent session')
    await expect(
      handlers['rlm.delete_subagent']!(request({ type: 'rlm.delete_subagent', target: 'dup' }), contextFor(agent('p'))),
    ).rejects.toThrow('RLM subagent selector "dup" is ambiguous in the current parent session')
  })
})

describe('bash notifications', () => {
  it('acks a valid bash.completed and validates its payload', async () => {
    const handlers = createRlmHostHandlers(deps())
    const reply = await handlers['bash.completed']!(
      request({ type: 'bash.completed', pid: 3, command: 'ls', exitCode: 0 }),
      contextFor(agent('p')),
    )
    expect(reply).toEqual({ status: 'ok', result: {} })
    await expect(
      call(handlers['bash.completed']!, request({ type: 'bash.completed', pid: -1, command: 'ls', exitCode: 0 }), contextFor(agent('p'))),
    ).rejects.toThrow('bash.completed pid must be a positive integer')
  })

  it('acks a valid bash.consumed and validates its payload', async () => {
    const handlers = createRlmHostHandlers(deps())
    const reply = await handlers['bash.consumed']!(
      request({ type: 'bash.consumed', pid: 3, command: 'ls' }),
      contextFor(agent('p')),
    )
    expect(reply).toEqual({ status: 'ok', result: {} })
    await expect(
      call(handlers['bash.consumed']!, request({ type: 'bash.consumed', pid: 3, command: '' }), contextFor(agent('p'))),
    ).rejects.toThrow('bash.consumed command must be a non-empty string')
  })
})
