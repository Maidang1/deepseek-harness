/**
 * Read-only family observation behind the agent-observe skill. The calling
 * session's nuclear family — its direct parent, its siblings, and its direct
 * children — is derived from the durable session header plus the subagent
 * catalogs; every family member is then read through one immutable session
 * cut from `ctx.sessionQuery`. Observation never mutates a session, and a
 * target outside the nuclear family is refused with the shared reach error.
 *
 * @module @deepseek-ai/dsh-rlm-bindings/observe
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SubagentCatalogEntry, SubagentTimingProjection } from '@deepseek-ai/dsh-subagent'
import type {
  RlmHostReplyData,
  RlmHostRequestContext,
  RlmHostRequestHandlers,
} from '@deepseek-ai/dsh-rlm-kernel'
import { foldChildFacts } from './child-facts.ts'
import { ok, stringField } from './read.ts'
import type { Roster } from './roster.ts'

/** Shared cap for the message previews carried by roster rows. */
export const AGENT_OBSERVE_PREVIEW_MAX_CHARS = 240

/** Default number of recent messages one `agent_observe.recent` call returns. */
export const DEFAULT_OBSERVE_LIMIT = 8

/** Default per-message preview size of one `agent_observe.recent` call. */
export const DEFAULT_OBSERVE_MAX_CHARS = 800

/** Refusal every out-of-family observation target receives. */
export const AGENT_FAMILY_REACH_ERROR = 'Agent reach is limited to parent, siblings, and children'

/** Sender or receiver position inside the nuclear family. */
export type AgentFamilyRelationship = 'parent' | 'sibling' | 'child'

/** The slice of `ctx.agents` family listing and delivery read through. */
export interface LiveAgentSource {
  /** The exact live agent of one durable session id, when resident. */
  get(id: SessionId): Agent | undefined
  /** All live top-level agents, in registration order. */
  roots(): Agent[]
}

/** The slice of `ctx.subagents` the family catalog reads through. */
export interface ChildCatalogSource {
  /** The current direct-child catalog of one parent session. */
  listChildren(parent: SessionId, signal?: AbortSignal): Promise<SubagentCatalogEntry[]>
}

/** The composition services the nuclear-family catalog is derived from. */
export interface FamilySource {
  /** The live-agent registry. */
  readonly agents: LiveAgentSource
  /** The direct-child catalog reader. */
  readonly subagents: ChildCatalogSource
  /** The per-composition child roster, consulted for sibling-unique names. */
  readonly roster: Roster
}

/** The pieces of one session observation the bindings read. */
export interface SessionCut {
  /** Immutable session identity metadata. */
  readonly header: SessionHeader
  /** The session log's events at the observation cut. */
  readonly events: readonly SessionEvent[]
  /** The projection snapshot at the same cut, when the registry is mounted. */
  readonly projections?: {
    readonly values: {
      readonly subagentTiming?: SubagentTimingProjection | undefined
    }
  }
}

/** The slice of `ctx.sessionQuery` observation reads go through. */
export interface SessionCutSource {
  /** One immutable cut over a session's header, log, and projections. */
  observeSession(
    sessionId: SessionId,
    options: { signal?: AbortSignal; projectionMode?: 'all' | 'none' },
  ): Promise<SessionCut & Disposable>
}

/** Everything the observation handlers need from the composition. */
export interface AgentObserveDeps extends FamilySource {
  /** The session observation reader. */
  readonly observations: SessionCutSource
}

/** One reachable family member, before any session-cut enrichment. */
export interface FamilyMember {
  /** The member's position relative to the calling session. */
  readonly relationship: AgentFamilyRelationship
  /** The member's durable session id, as a plain string. */
  readonly id: string
  /** Roster name, falling back to the catalog label and then the id. */
  readonly name: string
  /** The exact live agent, when the member is resident in this host. */
  readonly agent?: Agent
}

/** The calling session's nuclear family and its own display name. */
export interface FamilySnapshot {
  /** The calling session's roster name, catalog label, or id. */
  readonly selfName: string
  /** Parent first, then siblings, then children; each group sorted by name. */
  readonly members: readonly FamilyMember[]
}

/** One conversation message folded out of a session event cut. */
export interface FoldedMessage {
  /** Zero-based position among the cut's conversation messages. */
  readonly index: number
  /** The message role, taken from the persisted message. */
  readonly role: string
  /** Wall-clock time of the log event carrying the message. */
  readonly timestamp: number
  /** The joined text of the message's content blocks. */
  readonly text: string
  /** Names of the tool calls an assistant message requested, when any. */
  readonly toolCalls?: readonly string[]
}

/** One bounded message preview on the `agent_observe` wire. */
export type ObserveMessagePreview = {
  /** Zero-based position among the cut's conversation messages. */
  readonly index: number
  /** The message role, taken from the persisted message. */
  readonly role: string
  /** Wall-clock time of the log event carrying the message. */
  readonly timestamp: number
  /** The message text, clipped to the requested preview size. */
  readonly text: string
  /** True when the text was clipped. */
  readonly truncated: boolean
  /** Names of the tool calls an assistant message requested, when any. */
  readonly toolCalls?: string[]
}

/** One family member's summary on the `agent_observe` wire. */
export type ObserveAgentSummary = {
  /** Live session id; dsh keeps one durable id per session, repeated here. */
  readonly activeSessionId?: string
  /** The durable session id. */
  readonly sessionId: string
  /** Roster name, catalog label, or the durable id when neither is known. */
  readonly sessionName: string
  /** The member's position relative to the calling session. */
  readonly relationship?: AgentFamilyRelationship
  /** Coarse runtime classification, derived from the durable header. */
  readonly runtimeKind?: 'top-level' | 'subagent'
  /** Working directory recorded in the durable header. */
  readonly cwd?: string
  /** Coarse activity status. */
  readonly status: string
  /** True only on the calling session's own row. */
  readonly isCurrent: boolean
  /** True while the member has an open turn and is live. */
  readonly isStreaming: boolean
  /** Compaction state; dsh exposes no signal, always false. */
  readonly isCompacting: boolean
  /** Attached client count; dsh exposes no signal, always zero. */
  readonly attachedClients: number
  /** Count of conversation messages in the observed cut. */
  readonly messageCount?: number
  /** Pending inbox messages of a live member. */
  readonly queuedCount: number
  /** True while the member is resident in this host. */
  readonly isSessionActive: boolean
  /** Whether the member replied after its latest user message. */
  readonly repliedSinceTask?: boolean
  /** The member's durable parent session id, when it is a subagent child. */
  readonly parentSessionId?: string
  /** The member's first user message, clipped to the preview cap. */
  readonly firstMessage?: string
  /** Preview of the member's latest conversation message. */
  readonly latestMessage?: ObserveMessagePreview
}

/**
 * Join the text of one message's content blocks, one line per block.
 *
 * @param content - the content blocks of one persisted message.
 * @returns the joined human-readable text; non-text blocks become placeholders.
 */
export function contentText(content: readonly ContentBlock[]): string {
  return content
    .map((block) => {
      switch (block.type) {
        case 'text': return block.text
        case 'reasoning': return block.text
        case 'image': return '[image]'
        case 'file': return '[file]'
        case 'tool-call': return `[tool_call:${block.name}]`
        default: return ''
      }
    })
    .filter(line => line.length > 0)
    .join('\n')
}

/**
 * Fold one session event cut into its conversation messages, in log order.
 *
 * @param events - the session log's events at the observation cut.
 * @returns the folded conversation messages, indexed in log order.
 */
export function foldMessageEvents(events: readonly SessionEvent[]): FoldedMessage[] {
  const messages: FoldedMessage[] = []
  for (const event of events) {
    if (event.type === 'user/message') {
      messages.push(foldMessage(event.time, event.data, messages.length))
    } else if (event.type === 'developer/message') {
      messages.push(foldMessage(event.time, event.data.message, messages.length))
    } else if (event.type === 'system/message') {
      messages.push(foldMessage(event.time, event.data.message, messages.length))
    } else if (event.type === 'assistant/message') {
      messages.push(foldMessage(event.time, event.data.message, messages.length))
    } else if (event.type === 'tool/result') {
      messages.push(foldMessage(event.time, event.data.message, messages.length))
    }
  }
  return messages
}

interface FoldableMessage {
  readonly role: string
  readonly content: readonly ContentBlock[]
}

/** Fold one carried message into its preview source row. */
function foldMessage(time: number, message: FoldableMessage, index: number): FoldedMessage {
  const toolCalls = message.role === 'assistant'
    ? message.content.filter(block => block.type === 'tool-call').map(block => block.name)
    : undefined
  return {
    index,
    role: message.role,
    timestamp: time,
    text: contentText(message.content),
    ...toolCalls !== undefined && toolCalls.length > 0 ? { toolCalls } : {},
  }
}

/**
 * Clip one folded message to a bounded preview.
 *
 * @param message - the folded conversation message.
 * @param maxChars - the preview size cap, in UTF-16 code units.
 * @returns the wire preview, with `truncated` marking any clip.
 */
export function createMessagePreview(message: FoldedMessage, maxChars: number): ObserveMessagePreview {
  const clipped = message.text.length > maxChars
  return {
    index: message.index,
    role: message.role,
    timestamp: message.timestamp,
    text: clipped ? message.text.slice(0, maxChars) : message.text,
    truncated: clipped,
    ...message.toolCalls === undefined ? {} : { toolCalls: [...message.toolCalls] },
  }
}

/** Validate an optional integer payload member. */
function optionalInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer when provided`)
  }
  return value
}

/** Clamp one bounded integer argument. */
function clampInteger(value: number, min: number, max: number, label: string): number {
  if (value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}`)
  }
  return value
}

/**
 * Normalize the `limit` argument of one `agent_observe.recent` call.
 *
 * @param limit - the raw requested limit, when provided.
 * @returns the bounded limit.
 */
export function normalizeObserveLimit(limit: number | undefined): number {
  return clampInteger(limit ?? DEFAULT_OBSERVE_LIMIT, 1, 50, 'agent_observe limit')
}

/**
 * Normalize the `max_chars` argument of one `agent_observe.recent` call.
 *
 * @param maxChars - the raw requested preview size, when provided.
 * @returns the bounded preview size.
 */
export function normalizeObserveMaxChars(maxChars: number | undefined): number {
  return clampInteger(maxChars ?? DEFAULT_OBSERVE_MAX_CHARS, 80, 2_000, 'agent_observe max_chars')
}

/**
 * Derive the calling session's nuclear family from its durable header and
 * the subagent catalogs. A subagent child's siblings are its parent's other
 * catalog children; a top-level session's siblings are the other live roots,
 * matching the roots-are-siblings reach rule. Deeper ancestors and their
 * descendants stay unreachable: communication with them relays through the
 * intermediate family member.
 *
 * @param source - the composition services the catalog is derived from.
 * @param agent - the calling session's agent.
 * @param signal - cancellation while reading the catalogs.
 * @returns the family snapshot: own display name plus reachable members.
 */
export async function listFamilyMembers(
  source: FamilySource,
  agent: Agent,
  signal: AbortSignal,
): Promise<FamilySnapshot> {
  const currentId = String(agent.id)
  const parentId = agent.session.header.parentSession
  const byName = (left: FamilyMember, right: FamilyMember) => left.name.localeCompare(right.name)
  const members: FamilyMember[] = []
  let selfName = currentId
  if (parentId !== undefined) {
    const pid = String(parentId)
    members.push({ relationship: 'parent', id: pid, name: pid, ...liveMember(source, parentId) })
    const siblings: FamilyMember[] = []
    for (const entry of await source.subagents.listChildren(parentId, signal)) {
      const id = String(entry.id)
      const name = source.roster.entry(pid, id)?.name ?? entry.label ?? id
      if (id === currentId) {
        selfName = name
        continue
      }
      siblings.push({ relationship: 'sibling', id, name, ...liveMember(source, entry.id) })
    }
    siblings.sort(byName)
    members.push(...siblings)
  } else {
    const roots: FamilyMember[] = []
    for (const root of source.agents.roots()) {
      if (root.id === agent.id) continue
      roots.push({ relationship: 'sibling', id: String(root.id), name: String(root.id), agent: root })
    }
    roots.sort(byName)
    members.push(...roots)
  }
  const children: FamilyMember[] = []
  for (const entry of await source.subagents.listChildren(agent.id, signal)) {
    const id = String(entry.id)
    const name = source.roster.entry(currentId, id)?.name ?? entry.label ?? id
    children.push({ relationship: 'child', id, name, ...liveMember(source, entry.id) })
  }
  children.sort(byName)
  members.push(...children)
  return { selfName, members }
}

/** Spread the live-agent field of one family member, when resident. */
function liveMember(source: FamilySource, id: SessionId): { agent?: Agent } {
  const agent = source.agents.get(id)
  return agent === undefined ? {} : { agent }
}

/** One resolved observation target: a session id plus its summary options. */
interface ObserveTarget {
  /** The resolved durable session id. */
  readonly id: string
  /** The summary options for the resolved row. */
  readonly options: SummaryOptions
}

/** One target candidate: the calling session or a reachable family member. */
type TargetCandidate =
  | { readonly kind: 'current'; readonly id: string; readonly name: string }
  | { readonly kind: 'member'; readonly member: FamilyMember; readonly id: string; readonly name: string }

/** Project one matched candidate onto its observation target. */
function toObserveTarget(candidate: TargetCandidate): ObserveTarget {
  return candidate.kind === 'current'
    ? { id: candidate.id, options: { current: true, name: candidate.name } }
    : { id: candidate.member.id, options: { relationship: candidate.member.relationship, name: candidate.member.name } }
}

/**
 * Resolve one `agent_observe.get` / `agent_observe.recent` target selector
 * against the calling session and its reachable family, by exact id or name
 * first and by unambiguous suffix second.
 *
 * @param deps - the composition services.
 * @param agent - the calling session's agent.
 * @param target - the raw target selector.
 * @param signal - cancellation while reading the catalogs.
 * @returns the resolved target.
 */
async function resolveObserveTarget(
  deps: AgentObserveDeps,
  agent: Agent,
  target: string,
  signal: AbortSignal,
): Promise<ObserveTarget> {
  const family = await listFamilyMembers(deps, agent, signal)
  const candidates: TargetCandidate[] = [
    { kind: 'current', id: String(agent.id), name: family.selfName },
    ...family.members.map(member => ({ kind: 'member' as const, member, id: member.id, name: member.name })),
  ]
  const exact = candidates.filter(candidate => candidate.id === target || candidate.name === target)
  const matches = exact.length > 0
    ? exact
    : candidates.filter(candidate => candidate.id.endsWith(target) || candidate.name.endsWith(target))
  const [first, second] = matches
  if (first === undefined) throw new Error(AGENT_FAMILY_REACH_ERROR)
  if (second !== undefined) throw new Error(`agent_observe target ${JSON.stringify(target)} is ambiguous`)
  return toObserveTarget(first)
}

interface SummaryOptions {
  /** Whether the row describes the calling session itself. */
  readonly current?: boolean
  /** The member's family position, omitted on the calling session's row. */
  readonly relationship?: AgentFamilyRelationship
  /** The member's display name, always known (falling back to the id). */
  readonly name: string
}

/**
 * The coarse runtime classification of one session, from its durable header.
 *
 * @param header - the session's durable identity metadata.
 * @returns `subagent` for a delegated child, `top-level` otherwise.
 */
export function headerRuntimeKind(header: SessionHeader): 'top-level' | 'subagent' {
  return (header.delegationDepth ?? 0) > 0 || header.origin === 'subagent' ? 'subagent' : 'top-level'
}

/** Project one session cut plus live-registry facts onto a wire summary. */
function summarizeCut(
  deps: AgentObserveDeps,
  cut: SessionCut,
  id: string,
  options: SummaryOptions,
): ObserveAgentSummary {
  const facts = foldChildFacts(cut.events, cut.projections?.values.subagentTiming)
  const messages = foldMessageEvents(cut.events)
  const live = deps.agents.get(SessionId(id))
  const header = cut.header
  const running = facts.running
  const firstUser = messages.find(message => message.role === 'user')
  const latest = messages.at(-1)
  return {
    ...live === undefined ? {} : { activeSessionId: id },
    sessionId: id,
    sessionName: options.name,
    ...options.relationship === undefined ? {} : { relationship: options.relationship },
    runtimeKind: headerRuntimeKind(header),
    ...header.cwd === undefined ? {} : { cwd: header.cwd },
    status: running ? 'model' : live === undefined ? 'inactive' : 'idle',
    isCurrent: options.current === true,
    isStreaming: live !== undefined && running,
    isCompacting: false,
    attachedClients: 0,
    messageCount: messages.length,
    queuedCount: live === undefined ? 0 : live.inbox.nextTurn.length + live.inbox.nextStep.length,
    isSessionActive: live !== undefined,
    ...facts.repliedSinceTask === undefined ? {} : { repliedSinceTask: facts.repliedSinceTask },
    ...header.parentSession === undefined ? {} : { parentSessionId: String(header.parentSession) },
    ...firstUser === undefined ? {} : { firstMessage: firstUser.text.slice(0, AGENT_OBSERVE_PREVIEW_MAX_CHARS) },
    ...latest === undefined ? {} : { latestMessage: createMessagePreview(latest, AGENT_OBSERVE_PREVIEW_MAX_CHARS) },
  }
}

/** Observe one session and project its wire summary, disposing the lease. */
async function summarizeSession(
  deps: AgentObserveDeps,
  id: string,
  options: SummaryOptions,
  signal: AbortSignal,
): Promise<ObserveAgentSummary> {
  const cut = await deps.observations.observeSession(SessionId(id), { signal, projectionMode: 'all' })
  try {
    return summarizeCut(deps, cut, id, options)
  } finally {
    cut[Symbol.dispose]()
  }
}

/** Answer `agent_observe.list`: the calling session plus its whole family. */
async function runList(deps: AgentObserveDeps, context: RlmHostRequestContext): Promise<RlmHostReplyData> {
  const family = await listFamilyMembers(deps, context.agent, context.signal)
  const agents: ObserveAgentSummary[] = []
  for (const member of family.members) {
    agents.push(await summarizeSession(deps, member.id, { relationship: member.relationship, name: member.name }, context.signal))
  }
  return ok({
    current: await summarizeSession(deps, String(context.agent.id), { current: true, name: family.selfName }, context.signal),
    agents,
  })
}

/** Answer `agent_observe.get`: one reachable session's summary. */
async function runGet(
  deps: AgentObserveDeps,
  data: Readonly<Record<string, unknown>>,
  context: RlmHostRequestContext,
): Promise<RlmHostReplyData> {
  const target = stringField(data, 'target', 'agent_observe.get target must be a string')
  const resolved = await resolveObserveTarget(deps, context.agent, target, context.signal)
  return ok({ agent: await summarizeSession(deps, resolved.id, resolved.options, context.signal) })
}

/** Answer `agent_observe.recent`: bounded recent message previews of one reachable session. */
async function runRecent(
  deps: AgentObserveDeps,
  data: Readonly<Record<string, unknown>>,
  context: RlmHostRequestContext,
): Promise<RlmHostReplyData> {
  const target = stringField(data, 'target', 'agent_observe.recent target must be a string')
  const limit = normalizeObserveLimit(optionalInteger(data['limit'], 'agent_observe.recent limit'))
  const maxChars = normalizeObserveMaxChars(
    optionalInteger(data['max_chars'] ?? data['maxChars'], 'agent_observe.recent max_chars'),
  )
  const resolved = await resolveObserveTarget(deps, context.agent, target, context.signal)
  const cut = await deps.observations.observeSession(SessionId(resolved.id), { signal: context.signal, projectionMode: 'all' })
  try {
    const messages = foldMessageEvents(cut.events)
    const startIndex = Math.max(0, messages.length - limit)
    return ok({
      agent: summarizeCut(deps, cut, resolved.id, resolved.options),
      messages: messages.slice(startIndex).map(message => createMessagePreview(message, maxChars)),
      limit,
      maxChars,
      truncated: startIndex > 0,
    })
  } finally {
    cut[Symbol.dispose]()
  }
}

/**
 * Assemble the three observation handlers the agent-observe skill calls.
 *
 * @param deps - the composition services captured at load.
 * @returns the handler map to register on `ctx.rlmKernel`.
 */
export function createAgentObserveHostHandlers(deps: AgentObserveDeps): RlmHostRequestHandlers {
  return {
    'agent_observe.list': (_request, context) => runList(deps, context),
    'agent_observe.get': (request, context) => runGet(deps, request.data, context),
    'agent_observe.recent': (request, context) => runRecent(deps, request.data, context),
  }
}
