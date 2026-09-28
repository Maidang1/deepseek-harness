import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, Inbox } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { SubagentCatalogEntry } from '@deepseek-ai/dsh-subagent'
import type { RlmHostReplyData, RlmHostRequestContext } from '@deepseek-ai/dsh-rlm-kernel'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { Roster } from '../src/roster.ts'
import {
  AgentMessageRateLimiter,
  createAgentMessageHostHandlers,
  createAgentMessageId,
  formatAgentMessagePrompt,
  inverseRelationship,
  normalizeAgentSessionMessage,
  sanitizeMessageHeaderValue,
} from '../src/message.ts'
import type { AgentMessageDeps, AgentMessageReceipt } from '../src/message.ts'

function header(id: string, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 0, isSeeded: false, ...extra }
}

interface FakeAgentOptions {
  readonly meta?: Partial<SessionHeader>
  readonly status?: 'idle' | 'running'
  readonly inbox?: Inbox
  readonly onSteer?: (message: UserMessage) => void
}

function agent(id: string, options: FakeAgentOptions = {}): Agent {
  const session = Session.create(SessionId(id), [], header(id, { cwd: '/repo', ...options.meta }))
  return {
    id: SessionId(id),
    options: {},
    session,
    inbox: options.inbox ?? unsupportedInbox(),
    ctx: new Context(),
    status: options.status ?? 'idle',
    send: () => {},
    followup: () => {},
    steer: options.onSteer ?? (() => {}),
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

class FakeAgents {
  readonly live = new Map<string, Agent>()
  rootList: Agent[] = []

  get(id: SessionId): Agent | undefined {
    return this.live.get(String(id))
  }

  roots(): Agent[] {
    return this.rootList
  }
}

class FakeCatalog {
  readonly children = new Map<string, SubagentCatalogEntry[]>()

  listChildren(parent: SessionId): Promise<SubagentCatalogEntry[]> {
    return Promise.resolve(this.children.get(String(parent)) ?? [])
  }
}

function deps(overrides: Partial<AgentMessageDeps> = {}): AgentMessageDeps {
  return {
    agents: new FakeAgents(),
    subagents: new FakeCatalog(),
    roster: new Roster(),
    ...overrides,
  }
}

function contextFor(owner: Agent): RlmHostRequestContext {
  return { agent: owner, signal: new AbortController().signal }
}

function send(
  handlers: ReturnType<typeof createAgentMessageHostHandlers>,
  data: Record<string, JsonValue>,
  owner: Agent,
): Promise<RlmHostReplyData> {
  return handlers['agent_message.send']!({ event: 'host_request', id: '1', data }, contextFor(owner))
}

function okReceipt(reply: RlmHostReplyData): AgentMessageReceipt {
  if (reply.status !== 'ok') throw new Error('expected an ok reply')
  return reply.result as AgentMessageReceipt
}

function child(id: string, label?: string): SubagentCatalogEntry {
  return label === undefined
    ? { id: SessionId(id), createdAt: 0, mode: 'unknown' }
    : { id: SessionId(id), createdAt: 0, mode: 'continuable', label }
}

describe('AgentMessageRateLimiter', () => {
  it('spends the burst capacity and then reports the wait', () => {
    let now = 0
    const limiter = new AgentMessageRateLimiter({ capacity: 2, refillMs: 1_000, now: () => now })
    expect(limiter.tryConsume('a->b')).toEqual({ ok: true })
    expect(limiter.tryConsume('a->b')).toEqual({ ok: true })
    expect(limiter.tryConsume('a->b')).toEqual({ ok: false, retryAfterMs: 1_000 })
    now = 1_500
    expect(limiter.tryConsume('a->b')).toEqual({ ok: true })
    expect(limiter.tryConsume('a->b')).toEqual({ ok: false, retryAfterMs: 500 })
  })

  it('refunds a failed delivery without exceeding the capacity', () => {
    const limiter = new AgentMessageRateLimiter({ capacity: 1, refillMs: 1_000, now: () => 0 })
    limiter.refund('never-seen')
    expect(limiter.tryConsume('a->b')).toEqual({ ok: true })
    limiter.refund('a->b')
    expect(limiter.tryConsume('a->b')).toEqual({ ok: true })
    limiter.refund('a->b')
    limiter.refund('a->b')
    expect(limiter.tryConsume('a->b')).toEqual({ ok: true })
    expect(limiter.tryConsume('a->b')).toEqual({ ok: false, retryAfterMs: 1_000 })
  })

  it('uses the default knobs', () => {
    const limiter = new AgentMessageRateLimiter()
    for (let index = 0; index < 3; index += 1) {
      expect(limiter.tryConsume('a->b')).toEqual({ ok: true })
    }
    const denied = limiter.tryConsume('a->b')
    expect(denied.ok).toBe(false)
  })
})

describe('normalizeAgentSessionMessage', () => {
  it('trims the message', () => {
    expect(normalizeAgentSessionMessage('  hi there  ')).toBe('hi there')
  })

  it('rejects an empty message', () => {
    expect(() => normalizeAgentSessionMessage('   ')).toThrow('Agent session message cannot be empty')
  })

  it('rejects an over-long message', () => {
    const message = 'x'.repeat(16_385)
    expect(() => normalizeAgentSessionMessage(message)).toThrow('Agent session message is too long: 16385 chars exceeds 16384')
  })
})

describe('createAgentMessageId', () => {
  it('mints agentmsg_-prefixed identities', () => {
    const first = createAgentMessageId()
    expect(first.startsWith('agentmsg_')).toBe(true)
    expect(createAgentMessageId()).not.toBe(first)
  })
})

describe('inverseRelationship', () => {
  it('inverts parent and child and keeps sibling', () => {
    expect(inverseRelationship('parent')).toBe('child')
    expect(inverseRelationship('child')).toBe('parent')
    expect(inverseRelationship('sibling')).toBe('sibling')
  })
})

describe('sanitizeMessageHeaderValue', () => {
  it('strips header delimiters and falls back to unknown', () => {
    expect(sanitizeMessageHeaderValue('my worker, phase:1 [a]\n')).toBe('my worker phase 1 a')
    expect(sanitizeMessageHeaderValue(':[]')).toBe('unknown')
  })
})

describe('formatAgentMessagePrompt', () => {
  it('lays out the bracket header and the message', () => {
    expect(formatAgentMessagePrompt('child', 'worker-1', 'done')).toBe('[agent-message from child:worker-1]\n\ndone')
  })
})

describe('agent_message.list_agents', () => {
  it('always fails with the removal notice', async () => {
    const handlers = createAgentMessageHostHandlers(deps())
    await expect(handlers['agent_message.list_agents']!({ event: 'host_request', id: '1', data: {} }, contextFor(agent('a'))))
      .rejects.toThrow('agent_message.list_agents was removed')
  })
})

describe('agent_message.send validation', () => {
  it('requires a string message', async () => {
    const handlers = createAgentMessageHostHandlers(deps())
    await expect(send(handlers, { receiver_role: 'parent' }, agent('a')))
      .rejects.toThrow('agent_message.send message must be a string')
  })

  it('rejects positional targets', async () => {
    const handlers = createAgentMessageHostHandlers(deps())
    await expect(send(handlers, { target: 'kid-1', message: 'hi' }, agent('a')))
      .rejects.toThrow('positional agent_message.send targets are not supported; use receiver_role and receiver_name')
  })

  it('rejects a broadcast combined with role or name', async () => {
    const handlers = createAgentMessageHostHandlers(deps())
    await expect(send(handlers, { target: 'all', message: 'hi', receiver_role: 'child' }, agent('a')))
      .rejects.toThrow('agent_message.send broadcast cannot be combined with receiver_role/receiver_name')
    await expect(send(handlers, { target: 'all', message: 'hi', receiver_name: 'x' }, agent('a')))
      .rejects.toThrow('agent_message.send broadcast cannot be combined with receiver_role/receiver_name')
  })

  it('requires a known receiver role', async () => {
    const handlers = createAgentMessageHostHandlers(deps())
    await expect(send(handlers, { message: 'hi', receiver_role: 'uncle' }, agent('a')))
      .rejects.toThrow('agent_message.send receiver_role must be "parent", "sibling", or "child"')
  })

  it('rejects a receiver name for parent messages', async () => {
    const handlers = createAgentMessageHostHandlers(deps())
    await expect(send(handlers, { message: 'hi', receiver_role: 'parent', receiver_name: 'x' }, agent('a')))
      .rejects.toThrow('agent_message.send receiver_name must be omitted for parent messages')
  })

  it('requires a receiver name for sibling and child messages', async () => {
    const handlers = createAgentMessageHostHandlers(deps())
    await expect(send(handlers, { message: 'hi', receiver_role: 'sibling' }, agent('a')))
      .rejects.toThrow('agent_message.send receiver_name is required for sibling and child messages')
    await expect(send(handlers, { message: 'hi', receiver_role: 'child', receiver_name: '   ' }, agent('a')))
      .rejects.toThrow('agent_message.send receiver_name is required for sibling and child messages')
  })
})

describe('agent_message.send delivery', () => {
  function familySetup() {
    const agents = new FakeAgents()
    const catalog = new FakeCatalog()
    const roster = new Roster()
    const parent = agent('parent-1')
    const self = agent('self-1', { meta: { parentSession: SessionId('parent-1'), origin: 'subagent', delegationDepth: 1 } })
    const sibSteered: UserMessage[] = []
    const sibling = agent('sib-1', { meta: { parentSession: SessionId('parent-1'), origin: 'subagent', delegationDepth: 1 }, onSteer: message => sibSteered.push(message) })
    catalog.children.set('parent-1', [child('self-1'), child('sib-1')])
    catalog.children.set('self-1', [child('kid-1', 'kid-label')])
    roster.admit('parent-1', { childId: 'self-1', name: 'self-name', model: 'p/m', label: 'l', createdAt: 0 })
    roster.admit('parent-1', { childId: 'sib-1', name: 'sib-name', model: 'p/m', label: 'l', createdAt: 0 })
    agents.live.set('parent-1', parent)
    agents.live.set('self-1', self)
    agents.live.set('sib-1', sibling)
    return { agents, catalog, roster, parent, self, sibSteered }
  }

  it('delivers to the parent with a queued status while the parent runs', async () => {
    const { agents, catalog, roster, self } = familySetup()
    const parentSteered: UserMessage[] = []
    agents.live.set('parent-1', agent('parent-1', { status: 'running', onSteer: message => parentSteered.push(message) }))
    const handlers = createAgentMessageHostHandlers(deps({ agents, subagents: catalog, roster }))
    const receipt = okReceipt(await send(handlers, { message: '  answer  ', receiver_role: 'parent' }, self))
    expect(receipt.id.startsWith('agentmsg_')).toBe(true)
    expect(receipt.source).toBe('agent_message')
    expect(receipt.message).toBe('answer')
    expect(receipt.deliveryStatus).toBe('queued')
    expect(receipt.queuedAt).toBeDefined()
    expect(receipt.deliveredAt).toBeUndefined()
    expect(receipt.deliveryMode).toBe('steer')
    expect(receipt.target).toEqual({
      activeSessionId: 'parent-1',
      sessionId: 'parent-1',
      sessionName: 'parent-1',
      runtimeKind: 'top-level',
    })
    expect(receipt.from).toEqual({
      activeSessionId: 'self-1',
      sessionId: 'self-1',
      sessionName: 'self-name',
      runtimeKind: 'subagent',
    })
    expect(parentSteered).toHaveLength(1)
    expect(parentSteered[0]!.content).toEqual([{ type: 'text', text: '[agent-message from child:self-name]\n\nanswer' }])
    expect(parentSteered[0]!.source).toEqual({ kind: 'rlm-bindings' })
  })

  it('delivers to a sibling resolved by roster name', async () => {
    const { agents, catalog, roster, self, sibSteered } = familySetup()
    const handlers = createAgentMessageHostHandlers(deps({ agents, subagents: catalog, roster }))
    const receipt = okReceipt(await send(handlers, { message: 'ping', receiver_role: 'sibling', receiver_name: 'sib-name' }, self))
    expect(receipt.deliveryStatus).toBe('delivered')
    expect(receipt.deliveredAt).toBeDefined()
    expect(receipt.queuedAt).toBeUndefined()
    expect(sibSteered[0]!.content).toEqual([{ type: 'text', text: '[agent-message from sibling:self-name]\n\nping' }])
  })

  it('delivers to a child resolved by durable id', async () => {
    const { agents, catalog, roster, self } = familySetup()
    const kidSteered: UserMessage[] = []
    agents.live.set('kid-1', agent('kid-1', { meta: { parentSession: SessionId('self-1'), origin: 'subagent', delegationDepth: 2 }, onSteer: message => kidSteered.push(message) }))
    const handlers = createAgentMessageHostHandlers(deps({ agents, subagents: catalog, roster }))
    const receipt = okReceipt(await send(handlers, { message: 'go', receiver_role: 'child', receiver_name: 'kid-1' }, self))
    expect(receipt.target.sessionName).toBe('kid-label')
    expect(receipt.target.runtimeKind).toBe('subagent')
    expect(kidSteered[0]!.content).toEqual([{ type: 'text', text: '[agent-message from parent:self-name]\n\ngo' }])
  })

  it('accepts a null receiver name for parent messages', async () => {
    const { agents, catalog, roster, self } = familySetup()
    const handlers = createAgentMessageHostHandlers(deps({ agents, subagents: catalog, roster }))
    const receipt = okReceipt(await send(handlers, { message: 'hi', receiver_role: 'parent', receiver_name: null }, self))
    expect(receipt.deliveryStatus).toBe('delivered')
  })

  it('rejects an unknown role target with the role wording', async () => {
    const { agents, catalog, roster, self } = familySetup()
    const handlers = createAgentMessageHostHandlers(deps({ agents, subagents: catalog, roster }))
    await expect(send(handlers, { message: 'hi', receiver_role: 'parent' }, agent('lonely-root')))
      .rejects.toThrow('No parent matches the current agent')
    await expect(send(handlers, { message: 'hi', receiver_role: 'sibling', receiver_name: 'nobody' }, self))
      .rejects.toThrow('No sibling matches "nobody"')
  })

  it('rejects an ambiguous selector', async () => {
    const { agents, catalog, roster, self } = familySetup()
    catalog.children.set('self-1', [child('kid-a', 'twin'), child('kid-b', 'twin')])
    const handlers = createAgentMessageHostHandlers(deps({ agents, subagents: catalog, roster }))
    await expect(send(handlers, { message: 'hi', receiver_role: 'child', receiver_name: 'twin' }, self))
      .rejects.toThrow('child selector "twin" is ambiguous')
  })

  it('refuses to target the sending session', async () => {
    const { agents, catalog, roster, self } = familySetup()
    catalog.children.set('self-1', [child('self-1')])
    const handlers = createAgentMessageHostHandlers(deps({ agents, subagents: catalog, roster }))
    await expect(send(handlers, { message: 'hi', receiver_role: 'child', receiver_name: 'self-1' }, self))
      .rejects.toThrow('Agent messaging cannot target the sending session')
  })

  it('fails when the target session is not live, refunding the rate token', async () => {
    const { agents, catalog, roster, self } = familySetup()
    const handlers = createAgentMessageHostHandlers(deps({ agents, subagents: catalog, roster, rateLimit: { capacity: 1 } }))
    await expect(send(handlers, { message: 'hi', receiver_role: 'child', receiver_name: 'kid-1' }, self))
      .rejects.toThrow('agent_message.send: target session "kid-label" is not live in this host')
    agents.live.set('kid-1', agent('kid-1', { meta: { parentSession: SessionId('self-1'), origin: 'subagent', delegationDepth: 2 } }))
    const receipt = okReceipt(await send(handlers, { message: 'hi', receiver_role: 'child', receiver_name: 'kid-1' }, self))
    expect(receipt.deliveryStatus).toBe('delivered')
  })

  it('enforces the per-pair rate limit', async () => {
    const { agents, catalog, roster, self } = familySetup()
    const handlers = createAgentMessageHostHandlers(
      deps({ agents, subagents: catalog, roster, rateLimit: { capacity: 1, refillMs: 60_000 } }),
    )
    okReceipt(await send(handlers, { message: 'one', receiver_role: 'parent' }, self))
    await expect(send(handlers, { message: 'two', receiver_role: 'parent' }, self))
      .rejects.toThrow(/Agent messaging rate limit exceeded; retry after \d+ms/)
  })

  it('refunds the rate token when steering fails', async () => {
    const { agents, catalog, roster, self } = familySetup()
    let calls = 0
    agents.live.set('parent-1', agent('parent-1', {
      onSteer: () => {
        calls += 1
        if (calls === 1) throw new Error('steer broke')
      },
    }))
    const handlers = createAgentMessageHostHandlers(deps({ agents, subagents: catalog, roster, rateLimit: { capacity: 1 } }))
    await expect(send(handlers, { message: 'hi', receiver_role: 'parent' }, self)).rejects.toThrow('steer broke')
    const receipt = okReceipt(await send(handlers, { message: 'hi', receiver_role: 'parent' }, self))
    expect(receipt.deliveryStatus).toBe('delivered')
  })

  it('rejects an empty message', async () => {
    const { agents, catalog, roster, self } = familySetup()
    const handlers = createAgentMessageHostHandlers(deps({ agents, subagents: catalog, roster }))
    await expect(send(handlers, { message: '   ', receiver_role: 'parent' }, self))
      .rejects.toThrow('Agent session message cannot be empty')
  })

  it('broadcasts to the whole family, reporting per-member failures', async () => {
    const { agents, catalog, roster, self } = familySetup()
    agents.live.set('parent-1', agent('parent-1', {
      onSteer: () => {
        throw 'non-error failure'
      },
    }))
    const handlers = createAgentMessageHostHandlers(deps({ agents, subagents: catalog, roster }))
    const reply = await send(handlers, { target: 'all', message: 'news' }, self)
    if (reply.status !== 'ok') throw new Error('expected an ok reply')
    const receipts = (reply.result as { receipts: (AgentMessageReceipt | { target: string; error: string })[] }).receipts
    expect(receipts).toHaveLength(3)
    expect(receipts[0]).toEqual({ target: 'parent-1', error: 'non-error failure' })
    const siblingReceipt = receipts[1] as AgentMessageReceipt
    expect(siblingReceipt.target.sessionId).toBe('sib-1')
    expect(siblingReceipt.deliveryStatus).toBe('delivered')
    const kidReceipt = receipts[2] as { target: string; error: string }
    expect(kidReceipt).toEqual({ target: 'kid-1', error: 'agent_message.send: target session "kid-label" is not live in this host' })
  })

  it('addresses root siblings by their live root ids', async () => {
    const agents = new FakeAgents()
    const self = agent('root-1')
    const otherSteered: UserMessage[] = []
    const other = agent('root-2', { onSteer: message => otherSteered.push(message) })
    agents.rootList = [self, other]
    agents.live.set('root-2', other)
    const handlers = createAgentMessageHostHandlers(deps({ agents }))
    const receipt = okReceipt(await send(handlers, { message: 'hi root', receiver_role: 'sibling', receiver_name: 'root-2' }, self))
    expect(receipt.target.runtimeKind).toBe('top-level')
    expect(receipt.from.runtimeKind).toBe('top-level')
    expect(otherSteered[0]!.content).toEqual([{ type: 'text', text: '[agent-message from sibling:root-1]\n\nhi root' }])
  })
})
