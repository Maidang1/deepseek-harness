/**
 * Session-to-session messaging behind the agent-message skill. Routing is
 * nuclear-family only: the sender resolves its parent, siblings, or direct
 * children from the subagent catalogs, and the message is steered into the
 * resolved live session as a user message stamped with the bindings source.
 * A running target admits the steering at its nearest step boundary, which
 * the receipt reports as queued; an idle target starts a turn, reported as
 * delivered.
 *
 * @module @deepseek-ai/dsh-rlm-bindings/message
 */

import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, MessageSource } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  RlmHostReplyData,
  RlmHostRequestContext,
  RlmHostRequestHandlers,
} from '@deepseek-ai/dsh-rlm-kernel'
import { headerRuntimeKind, listFamilyMembers } from './observe.ts'
import type { AgentFamilyRelationship, FamilyMember, FamilySource } from './observe.ts'
import { ok } from './read.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Agent-to-agent messages steered into the receiving session. */
    'rlm-bindings': { kind: 'rlm-bindings' } & ContextFormed
  }
}

/** Producer source stamped on every steered agent message. */
const AGENT_MESSAGE_STEER_SOURCE: MessageSource = { kind: 'rlm-bindings' }

/** Durable source name carried by every agent-message receipt. */
export const AGENT_MESSAGE_SOURCE = 'agent_message'

/** Identity prefix distinguishing agent-to-agent messages. */
export const AGENT_MESSAGE_ID_PREFIX = 'agentmsg_'

/** Hard cap for one agent message, in UTF-16 code units. */
export const DEFAULT_AGENT_MESSAGE_MAX_CHARS = 16_384

/** Burst capacity of the per sender-target rate limiter. */
export const DEFAULT_AGENT_MESSAGE_RATE_LIMIT_CAPACITY = 3

/** Refill interval of the per sender-target rate limiter, in milliseconds. */
export const DEFAULT_AGENT_MESSAGE_RATE_LIMIT_REFILL_MS = 1_000

/** Reply one removed wire type always fails with. */
const REMOVED_LIST_AGENTS_MESSAGE = 'agent_message.list_agents was removed; the family roster now lives in '
  + 'agent_observe.list_agents(). Restart the Python kernel to load the current skills, then call '
  + 'await agent_observe.list_agents().'

/** One endpoint of a delivered agent message, as carried by the receipt. */
export type AgentMessageEndpoint = {
  /** Live session id; dsh keeps one durable id per session, repeated here. */
  readonly activeSessionId: string
  /** The durable session id. */
  readonly sessionId: string
  /** Roster name or catalog label, when the endpoint has one. */
  readonly sessionName?: string
  /** Coarse runtime classification, derived from the durable header. */
  readonly runtimeKind?: 'top-level' | 'subagent'
}

/** The receipt of one accepted agent message. */
export type AgentMessageReceipt = {
  /** Identity of the accepted message. */
  readonly id: string
  /** Durable source name, always {@link AGENT_MESSAGE_SOURCE}. */
  readonly source: typeof AGENT_MESSAGE_SOURCE
  /** The receiving endpoint. */
  readonly target: AgentMessageEndpoint
  /** The sending endpoint. */
  readonly from: AgentMessageEndpoint
  /** The normalized message text. */
  readonly message: string
  /** Whether the message started a turn or queued behind running work. */
  readonly deliveryStatus: 'delivered' | 'queued'
  /** When an idle target received the message. */
  readonly deliveredAt?: string
  /** When a running target parked the message for its next step boundary. */
  readonly queuedAt?: string
  /** Delivery mechanism, always steering. */
  readonly deliveryMode: 'steer'
}

/** Tuning knobs of the agent-message rate limiter. */
export interface AgentMessageRateLimitOptions {
  /** Burst capacity per sender-target pair. */
  readonly capacity?: number
  /** Milliseconds between token refills. */
  readonly refillMs?: number
  /** Clock override, for tests. */
  readonly now?: () => number
}

/**
 * Token-bucket limiter over sender-target pairs, ported from the reference
 * host: one token per send, refilled one per interval up to the capacity,
 * with a refund when the delivery itself fails.
 */
export class AgentMessageRateLimiter {
  private readonly capacity: number
  private readonly refillMs: number
  private readonly now: () => number
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>()

  /**
   * @param options - tuning knobs; defaults match the reference host.
   */
  constructor(options: AgentMessageRateLimitOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_AGENT_MESSAGE_RATE_LIMIT_CAPACITY
    this.refillMs = options.refillMs ?? DEFAULT_AGENT_MESSAGE_RATE_LIMIT_REFILL_MS
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * Take one token for a sender-target pair.
   *
   * @param key - the sender-target pair key.
   * @returns success, or the wait until the next token.
   */
  tryConsume(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = this.now()
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now }
    const elapsed = Math.max(0, now - bucket.updatedAt)
    const refilledTokens = Math.floor(elapsed / this.refillMs)
    if (refilledTokens > 0) {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + refilledTokens)
      bucket.updatedAt += refilledTokens * this.refillMs
    }
    if (bucket.tokens <= 0) {
      this.buckets.set(key, bucket)
      return { ok: false, retryAfterMs: Math.max(1, bucket.updatedAt + this.refillMs - now) }
    }
    bucket.tokens -= 1
    this.buckets.set(key, bucket)
    return { ok: true }
  }

  /**
   * Return one token after a failed delivery, so a send that never happened
   * does not spend the pair's budget.
   *
   * @param key - the sender-target pair key.
   */
  refund(key: string): void {
    const bucket = this.buckets.get(key)
    if (bucket === undefined) return
    bucket.tokens = Math.min(this.capacity, bucket.tokens + 1)
    this.buckets.set(key, bucket)
  }
}

/**
 * Normalize one outbound agent message: trimmed, non-empty, and within the
 * size cap. The error texts are model-facing and match the reference host.
 *
 * @param message - the raw message text.
 * @param maxChars - the size cap.
 * @returns the normalized message.
 */
export function normalizeAgentSessionMessage(
  message: string,
  maxChars: number = DEFAULT_AGENT_MESSAGE_MAX_CHARS,
): string {
  const trimmed = message.trim()
  if (trimmed.length === 0) throw new Error('Agent session message cannot be empty')
  if (trimmed.length > maxChars) {
    throw new Error(`Agent session message is too long: ${trimmed.length} chars exceeds ${maxChars}`)
  }
  return trimmed
}

/**
 * Mint the identity of one outbound agent message.
 *
 * @returns a fresh `agentmsg_`-prefixed id.
 */
export function createAgentMessageId(): string {
  return `${AGENT_MESSAGE_ID_PREFIX}${randomUUID()}`
}

/**
 * The sender's relationship from the receiver's point of view: the inverse
 * of the receiver role the send was addressed with.
 *
 * @param receiverRole - the role the receiver was addressed with.
 * @returns the sender's relationship to the receiver.
 */
export function inverseRelationship(receiverRole: AgentFamilyRelationship): AgentFamilyRelationship {
  switch (receiverRole) {
    case 'parent': return 'child'
    case 'child': return 'parent'
    case 'sibling': return 'sibling'
  }
}

/**
 * Strip the characters that would break the bracket header line of a steered
 * agent message: brackets, newlines, commas, and the relationship separator.
 *
 * @param value - a display name interpolated into the header.
 * @returns the safe header value, or `unknown` when nothing survives.
 */
export function sanitizeMessageHeaderValue(value: string): string {
  return value.replace(/[\s,:[\]]+/g, ' ').trim() || 'unknown'
}

/**
 * Format the model-facing text of one steered agent message, matching the
 * reference host's bracket grammar.
 *
 * @param fromRelationship - the sender's relationship from the receiver's point of view.
 * @param senderName - the sender's display name, sanitized for the header.
 * @param message - the normalized message text.
 * @returns the text the receiving session reads.
 */
export function formatAgentMessagePrompt(
  fromRelationship: AgentFamilyRelationship,
  senderName: string,
  message: string,
): string {
  const sender = sanitizeMessageHeaderValue(senderName)
  return `[agent-message from ${fromRelationship}:${sender}]\n\n${message}`
}

/** Everything the messaging handlers need from the composition. */
export interface AgentMessageDeps extends FamilySource {
  /** Rate limiter tuning; defaults match the reference host. */
  readonly rateLimit?: AgentMessageRateLimitOptions
}

/** Normalize and deliver one message to one resolved family member. */
function sendOne(
  deps: AgentMessageDeps,
  limiter: AgentMessageRateLimiter,
  sender: Agent,
  senderName: string,
  member: FamilyMember,
  rawMessage: string,
  receiverRole: AgentFamilyRelationship,
): AgentMessageReceipt {
  const message = normalizeAgentSessionMessage(rawMessage)
  if (member.id === String(sender.id)) {
    throw new Error('Agent messaging cannot target the sending session')
  }
  const key = `${String(sender.id)}->${member.id}`
  const lease = limiter.tryConsume(key)
  if (!lease.ok) {
    throw new Error(`Agent messaging rate limit exceeded; retry after ${lease.retryAfterMs}ms`)
  }
  const target = member.agent ?? deps.agents.get(SessionId(member.id))
  if (target === undefined) {
    limiter.refund(key)
    throw new Error(`agent_message.send: target session "${member.name}" is not live in this host`)
  }
  const steered = createUserMessage({
    content: [{ type: 'text', text: formatAgentMessagePrompt(inverseRelationship(receiverRole), senderName, message) }],
    source: AGENT_MESSAGE_STEER_SOURCE,
  })
  const queued = target.status === 'running'
  try {
    target.steer(steered)
  } catch (error: unknown) {
    limiter.refund(key)
    throw error
  }
  const at = new Date().toISOString()
  return {
    id: createAgentMessageId(),
    source: AGENT_MESSAGE_SOURCE,
    target: {
      activeSessionId: member.id,
      sessionId: member.id,
      sessionName: member.name,
      runtimeKind: headerRuntimeKind(target.session.header),
    },
    from: {
      activeSessionId: String(sender.id),
      sessionId: String(sender.id),
      sessionName: senderName,
      runtimeKind: headerRuntimeKind(sender.session.header),
    },
    message,
    deliveryStatus: queued ? 'queued' : 'delivered',
    ...queued ? { queuedAt: at } : { deliveredAt: at },
    deliveryMode: 'steer',
  }
}

/** Read the failure text of one settled broadcast leg. */
function rejectionMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/** Read the validated `message` member of one `agent_message.send` payload. */
function stringMessage(request: Readonly<Record<string, unknown>>): string {
  const message = request['message']
  if (typeof message !== 'string') {
    throw new Error('agent_message.send message must be a string')
  }
  return message
}

/** Answer `agent_message.send` addressed with `target: "all"`: every family member. */
async function runBroadcast(
  deps: AgentMessageDeps,
  limiter: AgentMessageRateLimiter,
  rawMessage: string,
  request: Readonly<Record<string, unknown>>,
  context: RlmHostRequestContext,
): Promise<RlmHostReplyData> {
  if (request['receiver_role'] !== undefined || request['receiver_name'] !== undefined) {
    throw new Error('agent_message.send broadcast cannot be combined with receiver_role/receiver_name')
  }
  const family = await listFamilyMembers(deps, context.agent, context.signal)
  const receipts: (AgentMessageReceipt | { readonly target: string; readonly error: string })[] = []
  for (const member of family.members) {
    try {
      receipts.push(sendOne(deps, limiter, context.agent, family.selfName, member, rawMessage, member.relationship))
    } catch (error: unknown) {
      receipts.push({ target: member.id, error: rejectionMessage(error) })
    }
  }
  return ok({ receipts })
}

/** Answer `agent_message.send` addressed with receiver_role and receiver_name. */
async function runSend(
  deps: AgentMessageDeps,
  limiter: AgentMessageRateLimiter,
  request: Readonly<Record<string, unknown>>,
  context: RlmHostRequestContext,
): Promise<RlmHostReplyData> {
  const rawMessage = stringMessage(request)
  const target = request['target']
  if (target !== undefined) {
    if (target !== 'all') {
      throw new Error('positional agent_message.send targets are not supported; use receiver_role and receiver_name')
    }
    return runBroadcast(deps, limiter, rawMessage, request, context)
  }
  const role = request['receiver_role']
  if (role !== 'parent' && role !== 'sibling' && role !== 'child') {
    throw new Error('agent_message.send receiver_role must be "parent", "sibling", or "child"')
  }
  const receiverName = request['receiver_name']
  if (role === 'parent' && receiverName !== undefined && receiverName !== null) {
    throw new Error('agent_message.send receiver_name must be omitted for parent messages')
  }
  if (role !== 'parent' && (typeof receiverName !== 'string' || receiverName.trim().length === 0)) {
    throw new Error('agent_message.send receiver_name is required for sibling and child messages')
  }
  const selector = typeof receiverName === 'string' ? receiverName.trim() : undefined
  const family = await listFamilyMembers(deps, context.agent, context.signal)
  const matches = family.members.filter(
    member => member.relationship === role && (role === 'parent' || member.name === selector || member.id === selector),
  )
  const [first, second] = matches
  if (first === undefined) {
    throw new Error(`No ${role} matches ${role === 'parent' ? 'the current agent' : JSON.stringify(receiverName)}`)
  }
  if (second !== undefined) {
    throw new Error(`${role} selector ${JSON.stringify(receiverName)} is ambiguous`)
  }
  return ok(sendOne(deps, limiter, context.agent, family.selfName, first, rawMessage, role))
}

/**
 * Assemble the messaging handlers the agent-message skill calls.
 *
 * @param deps - the composition services captured at load.
 * @returns the handler map to register on `ctx.rlmKernel`.
 */
export function createAgentMessageHostHandlers(deps: AgentMessageDeps): RlmHostRequestHandlers {
  const limiter = new AgentMessageRateLimiter(deps.rateLimit ?? {})
  return {
    'agent_message.list_agents': () => Promise.reject(new Error(REMOVED_LIST_AGENTS_MESSAGE)),
    'agent_message.send': (request, context) => runSend(deps, limiter, request.data, context),
  }
}
