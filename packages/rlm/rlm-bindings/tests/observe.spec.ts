import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, Inbox } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SubagentCatalogEntry, SubagentTimingProjection } from '@deepseek-ai/dsh-subagent'
import type { RlmHostReplyData, RlmHostRequestContext } from '@deepseek-ai/dsh-rlm-kernel'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { Roster } from '../src/roster.ts'
import {
  AGENT_FAMILY_REACH_ERROR,
  contentText,
  createAgentObserveHostHandlers,
  createMessagePreview,
  foldMessageEvents,
  headerRuntimeKind,
  listFamilyMembers,
  normalizeObserveLimit,
  normalizeObserveMaxChars,
} from '../src/observe.ts'
import type { AgentObserveDeps, SessionCut } from '../src/observe.ts'

function header(id: string, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 0, isSeeded: false, ...extra }
}

function agent(id: string, extra: Partial<SessionHeader> = {}, inbox: Inbox = unsupportedInbox()): Agent {
  const session = Session.create(SessionId(id), [], header(id, { cwd: '/repo', ...extra }))
  return {
    id: SessionId(id),
    options: {},
    session,
    inbox,
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

class FakeCuts {
  readonly cuts = new Map<string, { events: SessionEvent[]; timing?: SubagentTimingProjection; header?: SessionHeader }>()
  disposed = 0

  observeSession(sessionId: SessionId): Promise<SessionCut & Disposable> {
    const cut = this.cuts.get(String(sessionId)) ?? { events: [] }
    return Promise.resolve({
      header: cut.header ?? header(String(sessionId)),
      events: cut.events,
      ...cut.timing === undefined ? {} : { projections: { values: { subagentTiming: cut.timing } } },
      [Symbol.dispose]: () => { this.disposed += 1 },
    })
  }
}

function deps(overrides: Partial<AgentObserveDeps> = {}): AgentObserveDeps {
  return {
    agents: new FakeAgents(),
    subagents: new FakeCatalog(),
    roster: new Roster(),
    observations: new FakeCuts(),
    ...overrides,
  }
}

function contextFor(owner: Agent): RlmHostRequestContext {
  return { agent: owner, signal: new AbortController().signal }
}

function okResult(reply: RlmHostReplyData): Record<string, JsonValue> {
  if (reply.status !== 'ok') throw new Error('expected an ok reply')
  return reply.result as Record<string, JsonValue>
}

function child(id: string, label?: string): SubagentCatalogEntry {
  return label === undefined
    ? { id: SessionId(id), createdAt: 0, mode: 'unknown' }
    : { id: SessionId(id), createdAt: 0, mode: 'continuable', label }
}

function userMessage(text: string, content?: readonly ContentBlock[]): UserMessage {
  return { id: MessageId('mu'), role: 'user', content: content ?? [{ type: 'text', text }], source: { kind: 'user' } }
}

function assistantMessage(content: readonly ContentBlock[]): AssistantMessage {
  return { id: MessageId('ma'), role: 'assistant', content, source: { kind: 'model', provider: 'p', model: 'm' } }
}

let seq = 0

function event<T extends SessionEvent['type']>(type: T, data: SessionEvent<T>['data']): SessionEvent {
  seq += 1
  return { type, seq: SessionSeq(seq), time: 1_000 + seq, data } as SessionEvent
}

function user(text: string): SessionEvent {
  return event('user/message', userMessage(text))
}

function assistant(text: string, extra: readonly ContentBlock[] = []): SessionEvent {
  return event('assistant/message', { turn: 1, step: 0, message: assistantMessage([{ type: 'text', text }, ...extra]), stream: [] })
}

describe('contentText', () => {
  it('joins the text of every block kind, one line per block', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'hello' },
      { type: 'reasoning', text: 'thinking' },
      { type: 'image', attachment: {} as never },
      { type: 'file', attachment: {} as never },
      { type: 'tool-call', id: ToolCallId('c1'), name: 'bash', arguments: '{}' },
      { type: 'tool-addition', toolName: 'bash' },
      { type: 'text', text: '' },
    ]
    expect(contentText(blocks)).toBe('hello\nthinking\n[image]\n[file]\n[tool_call:bash]')
  })
})

describe('foldMessageEvents', () => {
  it('folds every message-carrying event and skips the rest', () => {
    const events: SessionEvent[] = [
      event('turn/start', { turn: 1 }),
      event('system/message', { turn: 1, step: 0, message: { id: MessageId('ms'), role: 'system', content: [{ type: 'text', text: 'sys' }], source: { kind: 'system-prompt' } } }),
      user('task'),
      event('developer/message', { turn: 1, step: 0, message: { id: MessageId('md'), role: 'developer', content: [{ type: 'text', text: 'dev' }], source: { kind: 'user' } } }),
      assistant('answer', [{ type: 'tool-call', id: ToolCallId('c1'), name: 'bash', arguments: '{}' }]),
      event('tool/result', { turn: 1, step: 0, message: { id: MessageId('mt'), role: 'tool', content: [{ type: 'text', text: 'out' }], source: { kind: 'tool', callId: ToolCallId('c1') }, toolCallId: ToolCallId('c1') } }),
      event('tool/call', { turn: 1, step: 0, callId: ToolCallId('c2'), name: 'bash', arguments: '{}' }),
    ]
    const messages = foldMessageEvents(events)
    expect(messages.map(message => message.role)).toEqual(['system', 'user', 'developer', 'assistant', 'tool'])
    expect(messages.map(message => message.index)).toEqual([0, 1, 2, 3, 4])
    expect(messages[3]!.toolCalls).toEqual(['bash'])
    expect(messages[1]!.toolCalls).toBeUndefined()
    expect(messages[3]!.timestamp).toBe(events[4]!.time)
  })
})

describe('createMessagePreview', () => {
  it('clips the text past the cap and marks the preview truncated', () => {
    const [folded] = foldMessageEvents([assistant('x'.repeat(300))])
    const preview = createMessagePreview(folded!, 80)
    expect(preview.text).toBe('x'.repeat(80))
    expect(preview.truncated).toBe(true)
  })

  it('keeps short text whole and copies the tool call names', () => {
    const [folded] = foldMessageEvents([assistant('hi', [{ type: 'tool-call', id: ToolCallId('c1'), name: 'bash', arguments: '{}' }])])
    const preview = createMessagePreview(folded!, 800)
    expect(preview).toEqual({ index: 0, role: 'assistant', timestamp: folded!.timestamp, text: 'hi\n[tool_call:bash]', truncated: false, toolCalls: ['bash'] })
  })
})

describe('normalizeObserveLimit / normalizeObserveMaxChars', () => {
  it('applies the defaults', () => {
    expect(normalizeObserveLimit(undefined)).toBe(8)
    expect(normalizeObserveMaxChars(undefined)).toBe(800)
  })

  it('accepts in-range values', () => {
    expect(normalizeObserveLimit(50)).toBe(50)
    expect(normalizeObserveLimit(1)).toBe(1)
    expect(normalizeObserveMaxChars(2_000)).toBe(2_000)
    expect(normalizeObserveMaxChars(80)).toBe(80)
  })

  it('rejects out-of-range values with the wire labels', () => {
    expect(() => normalizeObserveLimit(0)).toThrow('agent_observe limit must be between 1 and 50')
    expect(() => normalizeObserveLimit(51)).toThrow('agent_observe limit must be between 1 and 50')
    expect(() => normalizeObserveMaxChars(79)).toThrow('agent_observe max_chars must be between 80 and 2000')
    expect(() => normalizeObserveMaxChars(2_001)).toThrow('agent_observe max_chars must be between 80 and 2000')
  })
})

describe('headerRuntimeKind', () => {
  it('classifies delegated sessions as subagents and the rest as top-level', () => {
    expect(headerRuntimeKind(header('a'))).toBe('top-level')
    expect(headerRuntimeKind(header('a', { delegationDepth: 2 }))).toBe('subagent')
    expect(headerRuntimeKind(header('a', { origin: 'subagent' }))).toBe('subagent')
  })
})

describe('listFamilyMembers', () => {
  it('lists other live roots as the siblings of a top-level session', async () => {
    const agents = new FakeAgents()
    const self = agent('root-1')
    const otherB = agent('root-b')
    const otherA = agent('root-a')
    agents.rootList = [self, otherB, otherA]
    const catalog = new FakeCatalog()
    catalog.children.set('root-1', [child('child-1', 'beta'), child('child-2', 'alpha')])
    const family = await listFamilyMembers(deps({ agents, subagents: catalog }), self, new AbortController().signal)
    expect(family.selfName).toBe('root-1')
    expect(family.members.map(member => [member.relationship, member.name])).toEqual([
      ['sibling', 'root-a'],
      ['sibling', 'root-b'],
      ['child', 'alpha'],
      ['child', 'beta'],
    ])
    expect(family.members[0]!.agent).toBe(otherA)
    expect(family.members[2]!.agent).toBeUndefined()
  })

  it('lists parent, siblings, and children of a subagent child', async () => {
    const roster = new Roster()
    roster.admit('parent-1', { childId: 'self-1', name: 'self-name', model: 'p/m', label: 'l', createdAt: 0 })
    roster.admit('parent-1', { childId: 'sib-1', name: 'sib-name', model: 'p/m', label: 'l', createdAt: 0 })
    roster.admit('self-1', { childId: 'kid-1', name: 'kid-name', model: 'p/m', label: 'l', createdAt: 0 })
    const catalog = new FakeCatalog()
    catalog.children.set('parent-1', [child('sib-1'), child('self-1', 'self-label'), child('sib-2', 'sib-label'), child('sib-3')])
    catalog.children.set('self-1', [child('kid-1'), child('kid-2')])
    const self = agent('self-1', { parentSession: SessionId('parent-1'), origin: 'subagent', delegationDepth: 1 })
    const family = await listFamilyMembers(deps({ subagents: catalog, roster }), self, new AbortController().signal)
    expect(family.selfName).toBe('self-name')
    expect(family.members.map(member => [member.relationship, member.id, member.name])).toEqual([
      ['parent', 'parent-1', 'parent-1'],
      ['sibling', 'sib-3', 'sib-3'],
      ['sibling', 'sib-2', 'sib-label'],
      ['sibling', 'sib-1', 'sib-name'],
      ['child', 'kid-2', 'kid-2'],
      ['child', 'kid-1', 'kid-name'],
    ])
  })

  it('falls back to the catalog label for the calling session name', async () => {
    const catalog = new FakeCatalog()
    catalog.children.set('parent-1', [child('self-1', 'self-label')])
    const self = agent('self-1', { parentSession: SessionId('parent-1'), origin: 'subagent', delegationDepth: 1 })
    const family = await listFamilyMembers(deps({ subagents: catalog }), self, new AbortController().signal)
    expect(family.selfName).toBe('self-label')
  })
})

describe('agent_observe.list', () => {
  it('summarizes the calling session and every family member', async () => {
    const agents = new FakeAgents()
    const self = agent('root-1')
    const kidLive = agent('kid-1', { parentSession: SessionId('root-1'), origin: 'subagent', delegationDepth: 1 })
    agents.live.set('root-1', self)
    agents.live.set('kid-1', kidLive)
    const catalog = new FakeCatalog()
    catalog.children.set('root-1', [child('kid-1', 'kid'), child('kid-2', 'gone')])
    const cuts = new FakeCuts()
    cuts.cuts.set('root-1', { events: [user('do things'), assistant('working')], header: header('root-1', { cwd: '/repo' }) })
    cuts.cuts.set('kid-1', {
      events: [user('child task'), assistant('child answer')],
      timing: { settledMs: 5, active: { since: 10, through: 12 } },
      header: header('kid-1', { cwd: '/repo', parentSession: SessionId('root-1'), origin: 'subagent', delegationDepth: 1 }),
    })
    const handlers = createAgentObserveHostHandlers(deps({ agents, subagents: catalog, observations: cuts }))
    const reply = okResult(await handlers['agent_observe.list']!({ event: 'host_request', id: '1', data: {} }, contextFor(self)))
    const current = reply['current'] as Record<string, JsonValue>
    expect(current['sessionId']).toBe('root-1')
    expect(current['isCurrent']).toBe(true)
    expect(current['isSessionActive']).toBe(true)
    expect(current['status']).toBe('idle')
    expect(current['runtimeKind']).toBe('top-level')
    expect(current['cwd']).toBe('/repo')
    expect(current['messageCount']).toBe(2)
    expect(current['firstMessage']).toBe('do things')
    expect(current['relationship']).toBeUndefined()
    const rows = reply['agents'] as Record<string, JsonValue>[]
    expect(rows.map(row => row['sessionId'])).toEqual(['kid-2', 'kid-1'])
    const [gone, kid] = rows as [Record<string, JsonValue>, Record<string, JsonValue>]
    expect(kid['relationship']).toBe('child')
    expect(kid['sessionName']).toBe('kid')
    expect(kid['status']).toBe('model')
    expect(kid['isStreaming']).toBe(true)
    expect(kid['isSessionActive']).toBe(true)
    expect(kid['activeSessionId']).toBe('kid-1')
    expect(kid['runtimeKind']).toBe('subagent')
    expect(kid['parentSessionId']).toBe('root-1')
    expect(kid['repliedSinceTask']).toBe(true)
    expect(gone['status']).toBe('inactive')
    expect(gone['isSessionActive']).toBe(false)
    expect(gone['activeSessionId']).toBeUndefined()
    expect(gone['messageCount']).toBe(0)
    expect(cuts.disposed).toBe(3)
  })
})

describe('agent_observe.get', () => {
  it('requires a string target', async () => {
    const handlers = createAgentObserveHostHandlers(deps())
    await expect(handlers['agent_observe.get']!({ event: 'host_request', id: '1', data: {} }, contextFor(agent('a'))))
      .rejects.toThrow('agent_observe.get target must be a string')
  })

  it('resolves a family member by id, name, or suffix', async () => {
    const catalog = new FakeCatalog()
    catalog.children.set('root-1', [child('kid-abcdef', 'kid-name')])
    const self = agent('root-1')
    const handlers = createAgentObserveHostHandlers(deps({ subagents: catalog }))
    for (const target of ['kid-abcdef', 'kid-name', 'abcdef']) {
      const reply = okResult(await handlers['agent_observe.get']!({ event: 'host_request', id: '1', data: { target } }, contextFor(self)))
      const row = reply['agent'] as Record<string, JsonValue>
      expect(row['sessionId']).toBe('kid-abcdef')
      expect(row['relationship']).toBe('child')
    }
  })

  it('resolves the calling session itself', async () => {
    const self = agent('root-1')
    const handlers = createAgentObserveHostHandlers(deps())
    const reply = okResult(await handlers['agent_observe.get']!({ event: 'host_request', id: '1', data: { target: 'root-1' } }, contextFor(self)))
    const row = reply['agent'] as Record<string, JsonValue>
    expect(row['isCurrent']).toBe(true)
    expect(row['relationship']).toBeUndefined()
  })

  it('refuses targets outside the nuclear family', async () => {
    const handlers = createAgentObserveHostHandlers(deps())
    await expect(handlers['agent_observe.get']!({ event: 'host_request', id: '1', data: { target: 'stranger' } }, contextFor(agent('a'))))
      .rejects.toThrow(AGENT_FAMILY_REACH_ERROR)
  })

  it('rejects ambiguous selectors', async () => {
    const catalog = new FakeCatalog()
    catalog.children.set('root-1', [child('kid-x-shared', 'twin'), child('kid-y-shared', 'twin')])
    const handlers = createAgentObserveHostHandlers(deps({ subagents: catalog }))
    await expect(handlers['agent_observe.get']!({ event: 'host_request', id: '1', data: { target: 'twin' } }, contextFor(agent('root-1'))))
      .rejects.toThrow('agent_observe target "twin" is ambiguous')
    await expect(handlers['agent_observe.get']!({ event: 'host_request', id: '1', data: { target: 'shared' } }, contextFor(agent('root-1'))))
      .rejects.toThrow('agent_observe target "shared" is ambiguous')
  })
})

describe('agent_observe.recent', () => {
  function setup() {
    const catalog = new FakeCatalog()
    catalog.children.set('root-1', [child('kid-1', 'kid')])
    const cuts = new FakeCuts()
    cuts.cuts.set('kid-1', {
      events: [user('first'), assistant('second'), user('third'), assistant('fourth')],
    })
    const self = agent('root-1')
    const handlers = createAgentObserveHostHandlers(deps({ subagents: catalog, observations: cuts }))
    return { handlers, self, cuts }
  }

  it('returns bounded previews of the newest messages', async () => {
    const { handlers, self, cuts } = setup()
    const reply = okResult(await handlers['agent_observe.recent']!(
      { event: 'host_request', id: '1', data: { target: 'kid-1', limit: 2 } },
      contextFor(self),
    ))
    expect(reply['limit']).toBe(2)
    expect(reply['maxChars']).toBe(800)
    expect(reply['truncated']).toBe(true)
    const messages = reply['messages'] as Record<string, JsonValue>[]
    expect(messages.map(message => message['index'])).toEqual([2, 3])
    expect(messages.map(message => message['text'])).toEqual(['third', 'fourth'])
    const row = reply['agent'] as Record<string, JsonValue>
    expect(row['sessionId']).toBe('kid-1')
    expect(cuts.disposed).toBe(1)
  })

  it('defaults the limit and honors the maxChars alias', async () => {
    const { handlers, self, cuts } = setup()
    cuts.cuts.set('kid-1', { events: [assistant('y'.repeat(100))] })
    const reply = okResult(await handlers['agent_observe.recent']!(
      { event: 'host_request', id: '1', data: { target: 'kid-1', maxChars: 80 } },
      contextFor(self),
    ))
    expect(reply['truncated']).toBe(false)
    const messages = reply['messages'] as Record<string, JsonValue>[]
    expect(messages).toHaveLength(1)
    expect(messages[0]!['text']).toBe('y'.repeat(80))
    expect(messages[0]!['truncated']).toBe(true)
  })

  it('rejects a missing target and malformed bounds', async () => {
    const { handlers, self } = setup()
    await expect(handlers['agent_observe.recent']!({ event: 'host_request', id: '1', data: {} }, contextFor(self)))
      .rejects.toThrow('agent_observe.recent target must be a string')
    await expect(handlers['agent_observe.recent']!({ event: 'host_request', id: '1', data: { target: 'kid-1', limit: 2.5 } }, contextFor(self)))
      .rejects.toThrow('agent_observe.recent limit must be an integer when provided')
    await expect(handlers['agent_observe.recent']!({ event: 'host_request', id: '1', data: { target: 'kid-1', max_chars: 2.5 } }, contextFor(self)))
      .rejects.toThrow('agent_observe.recent max_chars must be an integer when provided')
    await expect(handlers['agent_observe.recent']!({ event: 'host_request', id: '1', data: { target: 'kid-1', limit: 0 } }, contextFor(self)))
      .rejects.toThrow('agent_observe limit must be between 1 and 50')
    await expect(handlers['agent_observe.recent']!({ event: 'host_request', id: '1', data: { target: 'kid-1', max_chars: 10_000 } }, contextFor(self)))
      .rejects.toThrow('agent_observe max_chars must be between 80 and 2000')
  })
})
