/**
 * The `refine.run` / `refine.status` host wires: continual harness refinement
 * scheduling for the kernel's refine skill. A run request never refines
 * mid-cell; it records a per-agent pending request that the `agent/turn-stopping`
 * boundary listener consumes, steering a refinement notice into the session so
 * the agent performs the refinement itself and resumes automatically. This
 * host has no separate refinement planner, so the notice replaces the side
 * pass the reference implementation runs at the same boundary.
 *
 * @module @deepseek-ai/dsh-rlm-bindings/refine
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, MessageSource, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  RlmHostReplyData,
  RlmHostRequestContext,
  RlmHostRequestEvent,
  RlmHostRequestHandlers,
} from '@deepseek-ai/dsh-rlm-kernel'
import { ok } from './read.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Refinement request notices steered into the requesting session. */
    'rlm-bindings': { kind: 'rlm-bindings' } & ContextFormed
  }
}

/** Producer source stamped on every refinement request notice. */
const REFINE_REQUEST_SOURCE: MessageSource = { kind: 'rlm-bindings' }

/** Model-facing note of an accepted `refine.run`, mirroring the reference host. */
const REFINE_SCHEDULED_NOTE =
  'Refinement runs when the current turn ends; the request is then steered into your context ' +
  'as a refinement notice and you resume automatically. Continue working normally.'

/** Model-facing reason of a `refine.run` refused outside an active turn. */
const REFINE_NO_ACTIVE_TURN_REASON = 'no active turn; refine can only be requested while a turn is running'

/** One scheduled refinement request, as merged `refine.run` arguments carry it. */
export interface RefineRequest {
  /** Focus instructions for the refinement pass. */
  readonly instructions?: string
  /** Whether the refinement targets the global, cross-session harness store. */
  readonly global?: boolean
}

interface AgentRefineState {
  pending?: RefineRequest
  inFlight: boolean
}

/**
 * Per-agent scheduled refinement state. The state is in-process and volatile:
 * a host restart drops pending requests and in-flight stamps, matching the
 * roster's durability policy.
 */
export class RefineRequests {
  private readonly states = new Map<string, AgentRefineState>()

  /**
   * Schedule one refinement for an agent, merging over any earlier request of
   * the same turn: a repeated `refine.run` only updates the fields it carries.
   *
   * @param agentId - the requesting session's id.
   * @param update - the validated `refine.run` arguments.
   */
  schedule(agentId: string, update: RefineRequest): void {
    let state = this.states.get(agentId)
    if (state === undefined) {
      state = { inFlight: false }
      this.states.set(agentId, state)
    }
    const instructions = update.instructions ?? state.pending?.instructions
    const global = update.global ?? state.pending?.global
    state.pending = {
      ...instructions === undefined ? {} : { instructions },
      ...global === undefined ? {} : { global },
    }
  }

  /**
   * Whether one agent has a refinement queued for its current turn.
   *
   * @param agentId - the session's id.
   * @returns the pending flag of the `refine.status` reply.
   */
  isPending(agentId: string): boolean {
    return this.states.get(agentId)?.pending !== undefined
  }

  /**
   * Whether one agent's refinement was consumed at a turn boundary and its
   * notice has not yet worked through the reopened turn.
   *
   * @param agentId - the session's id.
   * @returns the in-flight flag of the `refine.status` reply.
   */
  isInFlight(agentId: string): boolean {
    return this.states.get(agentId)?.inFlight === true
  }

  /**
   * Take one agent's pending request at its turn boundary, marking the
   * refinement in flight.
   *
   * @param agentId - the session whose turn is closing.
   * @returns the scheduled request, or `undefined` when none is pending.
   */
  consume(agentId: string): RefineRequest | undefined {
    const state = this.states.get(agentId)
    const pending = state?.pending
    if (state === undefined || pending === undefined) return undefined
    delete state.pending
    state.inFlight = true
    return pending
  }

  /**
   * Clear one agent's in-flight stamp when its turn boundary arrives with no
   * further pending request.
   *
   * @param agentId - the session whose turn is closing.
   */
  settle(agentId: string): void {
    const state = this.states.get(agentId)
    if (state === undefined) return
    state.inFlight = false
  }

  /**
   * Drop every refinement state of one agent, e.g. on disposal.
   *
   * @param agentId - the disposed session's id.
   */
  forget(agentId: string): void {
    this.states.delete(agentId)
  }
}

/** Everything the refinement handlers and boundary listener share. */
export interface RefineDeps {
  /** Per-agent scheduled refinement state. */
  readonly requests: RefineRequests
}

/**
 * Read and validate the arguments of one `refine.run` payload, with the
 * reference host's error messages.
 *
 * @param data - the `host_request` payload.
 * @returns the validated request update.
 */
function refineRunField(data: Readonly<Record<string, unknown>>): RefineRequest {
  const instructions = data['instructions']
  if (instructions !== undefined && typeof instructions !== 'string') {
    throw new Error('refine.run instructions must be a string when provided')
  }
  const global = data['global']
  if (global !== undefined && typeof global !== 'boolean') {
    throw new Error('refine.run global must be a boolean when provided')
  }
  return {
    ...instructions === undefined ? {} : { instructions },
    ...global === undefined ? {} : { global },
  }
}

/**
 * Format the model-facing text of one refinement request notice.
 *
 * @param request - the scheduled refinement consumed at the turn boundary.
 * @returns the header line, the instruction body, and the optional focus.
 */
export function formatRefineRequestNotice(request: RefineRequest): string {
  const scope = request.global === true ? 'global' : 'local'
  const body = request.global === true
    ? 'A continual harness refinement of the global, cross-session store was scheduled for this turn ' +
      'boundary. This host has no separate refinement planner, so perform the refinement yourself now: ' +
      'review the recent trajectory and apply small, evidence-backed edits through `rlm.harness`, keeping ' +
      'only stable cross-session lessons, durable user preferences, and reusable skills or subagent specs ' +
      'in the global store. Then continue your task.'
    : 'A continual harness refinement of this session\'s local store was scheduled for this turn boundary. ' +
      'This host has no separate refinement planner, so perform the refinement yourself now: review the ' +
      'recent trajectory and apply small, evidence-backed edits to the continual harness (prompt notes, ' +
      'memories, skills, subagent specs) through `rlm.harness`. Do not rewrite the whole harness when one ' +
      'focused entry is enough. Then continue your task.'
  const focus = request.instructions === undefined ? '' : `\n\nFocus: ${request.instructions}`
  return `[refine-requested scope:${scope}]\n\n${body}${focus}`
}

/**
 * Build the steered user message carrying one refinement request.
 *
 * @param request - the scheduled refinement consumed at the turn boundary.
 * @returns the identified message to steer into the requesting session.
 */
export function createRefineRequestMessage(request: RefineRequest): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: formatRefineRequestNotice(request) }],
    source: REFINE_REQUEST_SOURCE,
  })
}

/** The `agent/turn-stopping` payload the boundary listener reads. */
export interface RefineTurnStoppingPayload {
  /** The agent whose turn is at its stop boundary. */
  readonly agent: Agent
}

/**
 * Build the `agent/turn-stopping` listener that services scheduled
 * refinements. A pending request is consumed and steered into the session as
 * a refinement notice; the machine re-reads the inbox, so the turn reopens
 * and the agent resumes with the notice. A boundary without a pending request
 * settles the in-flight stamp of the previous consumption.
 *
 * @param deps - the shared per-agent refinement state.
 * @returns the serial turn-boundary listener.
 */
export function createRefineTurnStopping(deps: RefineDeps): (payload: RefineTurnStoppingPayload) => void {
  return ({ agent }) => {
    const agentId = String(agent.id)
    const pending = deps.requests.consume(agentId)
    if (pending === undefined) {
      deps.requests.settle(agentId)
      return
    }
    agent.steer(createRefineRequestMessage(pending))
  }
}

/**
 * Assemble the two host handlers the refine skill's wires answer.
 *
 * @param deps - the shared per-agent refinement state.
 * @returns the handler map to register on `ctx.rlmKernel`.
 */
export function createRefineHostHandlers(deps: RefineDeps): RlmHostRequestHandlers {
  return {
    'refine.status': (_request: RlmHostRequestEvent, context: RlmHostRequestContext): Promise<RlmHostReplyData> => {
      const agentId = String(context.agent.id)
      return Promise.resolve(ok({
        pending: deps.requests.isPending(agentId),
        in_flight: deps.requests.isInFlight(agentId),
      }))
    },
    'refine.run': (request: RlmHostRequestEvent, context: RlmHostRequestContext): Promise<RlmHostReplyData> => {
      const update = refineRunField(request.data)
      if (context.agent.status !== 'running') {
        return Promise.resolve(ok({ scheduled: false, reason: REFINE_NO_ACTIVE_TURN_REASON }))
      }
      deps.requests.schedule(String(context.agent.id), update)
      return Promise.resolve(ok({ scheduled: true, note: REFINE_SCHEDULED_NOTE }))
    },
  }
}
