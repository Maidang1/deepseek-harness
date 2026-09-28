import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus, Inbox } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type {
  RlmHostReplyData,
  RlmHostRequestContext,
  RlmHostRequestEvent,
  RlmHostRequestHandler,
} from '@deepseek-ai/dsh-rlm-kernel'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  createRefineHostHandlers,
  createRefineRequestMessage,
  createRefineTurnStopping,
  formatRefineRequestNotice,
  RefineRequests,
} from '../src/refine.ts'

interface FakeAgent {
  readonly agent: Agent
  readonly steered: UserMessage[]
  setStatus(status: AgentStatus): void
}

function agent(id: string, status: AgentStatus = 'running', inbox: Inbox = unsupportedInbox()): FakeAgent {
  const session = Session.create(SessionId(id), [], {
    version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 0, cwd: '/repo', isSeeded: false,
  })
  const steered: UserMessage[] = []
  const holder = { status }
  const fake: Agent = {
    id: SessionId(id),
    options: {},
    session,
    inbox,
    ctx: new Context(),
    get status() { return holder.status },
    send: () => {},
    followup: () => {},
    steer: (message: UserMessage) => { steered.push(message) },
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  return { agent: fake, steered, setStatus: (next) => { holder.status = next } }
}

function request(data: RlmHostRequestEvent['data']): RlmHostRequestEvent {
  return { event: 'host_request', id: '1', data }
}

function contextFor(owner: Agent, signal = new AbortController().signal): RlmHostRequestContext {
  return { agent: owner, signal }
}

/** Invoke one handler, wrapping a synchronous throw as a rejection. */
async function invoke(
  handler: RlmHostRequestHandler,
  req: RlmHostRequestEvent,
  ctx: RlmHostRequestContext,
): Promise<RlmHostReplyData> {
  return handler(req, ctx)
}

/** Unwrap an ok reply, failing the test on an error reply. */
function okResult(reply: RlmHostReplyData): JsonValue {
  if (reply.status !== 'ok') throw new Error('expected an ok reply')
  return reply.result
}

describe('RefineRequests', () => {
  it('reports no state for an unknown agent', () => {
    const requests = new RefineRequests()
    expect(requests.isPending('a')).toBe(false)
    expect(requests.isInFlight('a')).toBe(false)
    expect(requests.consume('a')).toBeUndefined()
  })

  it('schedules an empty update as a pending request', () => {
    const requests = new RefineRequests()
    requests.schedule('a', {})
    expect(requests.isPending('a')).toBe(true)
    expect(requests.consume('a')).toEqual({})
  })

  it('merges a repeated schedule over the pending request field by field', () => {
    const requests = new RefineRequests()
    requests.schedule('a', { instructions: 'first', global: true })
    requests.schedule('a', { instructions: 'second' })
    expect(requests.consume('a')).toEqual({ instructions: 'second', global: true })
    requests.schedule('a', { instructions: 'third', global: true })
    requests.schedule('a', { global: false })
    expect(requests.consume('a')).toEqual({ instructions: 'third', global: false })
  })

  it('keeps agent states apart', () => {
    const requests = new RefineRequests()
    requests.schedule('a', { instructions: 'for a' })
    expect(requests.isPending('b')).toBe(false)
    expect(requests.consume('b')).toBeUndefined()
    expect(requests.consume('a')).toEqual({ instructions: 'for a' })
  })

  it('marks a consumed request in flight until settled', () => {
    const requests = new RefineRequests()
    requests.schedule('a', {})
    requests.consume('a')
    expect(requests.isPending('a')).toBe(false)
    expect(requests.isInFlight('a')).toBe(true)
    requests.settle('a')
    expect(requests.isInFlight('a')).toBe(false)
  })

  it('tolerates settle and forget on an unknown agent', () => {
    const requests = new RefineRequests()
    requests.settle('stray')
    requests.forget('stray')
    expect(requests.isPending('stray')).toBe(false)
  })

  it('forgets every state of one agent', () => {
    const requests = new RefineRequests()
    requests.schedule('a', {})
    requests.consume('a')
    requests.schedule('a', { instructions: 'again' })
    requests.forget('a')
    expect(requests.isPending('a')).toBe(false)
    expect(requests.isInFlight('a')).toBe(false)
  })
})

describe('formatRefineRequestNotice', () => {
  it('announces a session-local refinement without a focus line', () => {
    const text = formatRefineRequestNotice({})
    expect(text).toContain('[refine-requested scope:local]')
    expect(text).toContain("session's local store")
    expect(text).not.toContain('Focus:')
  })

  it('announces a global refinement with its focus instructions', () => {
    const text = formatRefineRequestNotice({ instructions: 'keep it small', global: true })
    expect(text).toContain('[refine-requested scope:global]')
    expect(text).toContain('global, cross-session store')
    expect(text).toContain('\n\nFocus: keep it small')
  })
})

describe('createRefineRequestMessage', () => {
  it('builds an identified user message from the rlm-bindings source', () => {
    const request = { instructions: 'focus here' }
    const message = createRefineRequestMessage(request)
    expect(message.role).toBe('user')
    expect(message.id).not.toBe('')
    expect(message.source).toEqual({ kind: 'rlm-bindings' })
    expect(message.content).toEqual([{ type: 'text', text: formatRefineRequestNotice(request) }])
  })
})

describe('createRefineTurnStopping', () => {
  it('settles the in-flight stamp when no request is pending', () => {
    const requests = new RefineRequests()
    requests.schedule('a', {})
    requests.consume('a')
    const owner = agent('a')
    const listener = createRefineTurnStopping({ requests })
    listener({ agent: owner.agent })
    expect(owner.steered).toEqual([])
    expect(requests.isInFlight('a')).toBe(false)
  })

  it('steers a pending request into the session as a refinement notice', () => {
    const requests = new RefineRequests()
    requests.schedule('a', { instructions: 'do it' })
    const owner = agent('a')
    createRefineTurnStopping({ requests })({ agent: owner.agent })
    expect(requests.isPending('a')).toBe(false)
    expect(requests.isInFlight('a')).toBe(true)
    expect(owner.steered).toHaveLength(1)
    expect(owner.steered[0]!.content).toEqual([
      { type: 'text', text: formatRefineRequestNotice({ instructions: 'do it' }) },
    ])
  })
})

describe('refine.run', () => {
  it('rejects a non-string instructions member', async () => {
    const handlers = createRefineHostHandlers({ requests: new RefineRequests() })
    await expect(
      invoke(handlers['refine.run']!, request({ type: 'refine.run', instructions: 1 }), contextFor(agent('a').agent)),
    ).rejects.toThrow('refine.run instructions must be a string when provided')
  })

  it('rejects a non-boolean global member', async () => {
    const handlers = createRefineHostHandlers({ requests: new RefineRequests() })
    await expect(
      invoke(handlers['refine.run']!, request({ type: 'refine.run', global: 'yes' }), contextFor(agent('a').agent)),
    ).rejects.toThrow('refine.run global must be a boolean when provided')
  })

  it('refuses to schedule while the agent has no active turn', async () => {
    const requests = new RefineRequests()
    const handlers = createRefineHostHandlers({ requests })
    const reply = await handlers['refine.run']!(
      request({ type: 'refine.run', instructions: 'later' }),
      contextFor(agent('a', 'idle').agent),
    )
    expect(okResult(reply)).toEqual({
      scheduled: false,
      reason: 'no active turn; refine can only be requested while a turn is running',
    })
    expect(requests.isPending('a')).toBe(false)
  })

  it('schedules the request of a running agent', async () => {
    const requests = new RefineRequests()
    const handlers = createRefineHostHandlers({ requests })
    const reply = await handlers['refine.run']!(
      request({ type: 'refine.run', instructions: 'note the tactic', global: true }),
      contextFor(agent('a').agent),
    )
    expect(okResult(reply)).toEqual({
      scheduled: true,
      note: 'Refinement runs when the current turn ends; the request is then steered into your context ' +
        'as a refinement notice and you resume automatically. Continue working normally.',
    })
    expect(requests.consume('a')).toEqual({ instructions: 'note the tactic', global: true })
  })

  it('schedules a bare request without arguments', async () => {
    const requests = new RefineRequests()
    const handlers = createRefineHostHandlers({ requests })
    const reply = await handlers['refine.run']!(request({ type: 'refine.run' }), contextFor(agent('a').agent))
    expect(okResult(reply)).toMatchObject({ scheduled: true })
    expect(requests.consume('a')).toEqual({})
  })
})

describe('refine.status', () => {
  it('reports the scheduled and in-flight flags of the requesting agent', async () => {
    const requests = new RefineRequests()
    const handlers = createRefineHostHandlers({ requests })
    const owner = agent('a')
    const status = () => handlers['refine.status']!(request({ type: 'refine.status' }), contextFor(owner.agent))
    expect(okResult(await status())).toEqual({ pending: false, in_flight: false })
    await handlers['refine.run']!(request({ type: 'refine.run' }), contextFor(owner.agent))
    expect(okResult(await status())).toEqual({ pending: true, in_flight: false })
    createRefineTurnStopping({ requests })({ agent: owner.agent })
    expect(okResult(await status())).toEqual({ pending: false, in_flight: true })
    createRefineTurnStopping({ requests })({ agent: owner.agent })
    expect(okResult(await status())).toEqual({ pending: false, in_flight: false })
  })
})
