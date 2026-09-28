/**
 * Host handlers for the compact skill's `compact.run` and `compact.status`
 * requests. Compacting mid-cell would abort the run executing the requesting
 * cell, so `compact.run` only records the request and compacts through
 * `ctx.compaction` once the calling agent settles to idle; `compact.status`
 * reads the current request pressure through the token meter and reports
 * whether a compaction is already pending.
 *
 * @module @deepseek-ai/dsh-rlm-bindings/compact
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type {
  RlmHostReplyData,
  RlmHostRequestContext,
  RlmHostRequestEvent,
  RlmHostRequestHandlers,
} from '@deepseek-ai/dsh-rlm-kernel'
import { ok } from './read.ts'

/**
 * The agent surface an explicit compaction runs against. This is the
 * structural minimum of the compaction seam's manual-compaction context; the
 * composition's `Agent` satisfies it.
 */
export interface CompactionAgent {
  /** The live session whose durable history is compacted. */
  readonly session: Session
  /** The provider/model route guiding summarization. */
  readonly options: {
    readonly provider?: string
    readonly model?: string
  }
  /** Serialize one idle-phase maintenance task against driver turns. */
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
}

/** The slice of `ctx.compaction` the bindings drive. */
export interface CompactBackend {
  /**
   * Compact useful history once the agent is idle.
   * @param agent - idle agent whose durable history should be compacted.
   * @param signal - cancellation scoped to this compaction request.
   * @returns settlement of the attempt; `null` marks a no-op.
   */
  compactNow(agent: CompactionAgent, signal: AbortSignal): Promise<unknown>
}

/** The slice of `ctx.tokenMeter` the bindings read for context pressure. */
export interface CompactUsageSource {
  /**
   * Measure current request pressure of one session.
   * @param session - session to measure.
   * @returns a snapshot carrying the total request-and-response tokens.
   */
  measure(session: Session): { readonly totalTokens: number }
}

/** The slice of `ctx.llm` compact status resolves context capacity through. */
export interface CompactModelCatalog {
  /**
   * Resolve adapter-owned metadata of one exact provider/model route.
   * @param provider - registered provider route to inspect.
   * @param model - exact model id on that route.
   * @param signal - optional cancellation for the adapter lookup.
   * @returns the route's metadata, with context capacity when known.
   */
  resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ readonly context?: { readonly contextWindow: number } }>
}

/** Everything the compact host handlers need from the composition, captured at load. */
export interface CompactBindingDeps {
  /** The compaction engine running the deferred request. */
  readonly compaction: CompactBackend
  /** The token meter reporting current pressure. */
  readonly usage: CompactUsageSource
  /** The model catalog resolving the route's context window. */
  readonly models: CompactModelCatalog
}

/** Pending compaction requests and their idle drains, keyed by session id. */
interface CompactState {
  /**
   * Latest requested instructions per session; presence alone means a
   * compaction is scheduled. The current compaction seam accepts no custom
   * instructions, so the text is retained only for a future engine that does.
   */
  readonly pending: Map<string, string | undefined>
  /** Sessions with an idle-drain loop already running. */
  readonly draining: Set<string>
}

/**
 * Compact one session each time a pending request survives to an idle phase.
 * The requesting cell was already answered, so a failed attempt is swallowed
 * here; it stays visible in the session log, matching the manual-compaction
 * contract.
 */
async function drainPending(
  deps: CompactBindingDeps,
  state: CompactState,
  key: string,
  agent: Agent,
  signal: AbortSignal,
): Promise<void> {
  for (;;) {
    await agent.whenIdle()
    if (!state.pending.delete(key)) return
    try {
      await deps.compaction.compactNow(agent, signal)
    } catch {
      // Failure is not reportable to the answered cell; the log keeps it.
    }
  }
}

/** Answer `compact.run`: record the request; compaction fires at the next idle phase. */
function runCompact(
  deps: CompactBindingDeps,
  state: CompactState,
  request: RlmHostRequestEvent,
  context: RlmHostRequestContext,
): RlmHostReplyData {
  const instructions = request.data['instructions']
  if (instructions !== undefined && typeof instructions !== 'string') {
    throw new Error('compact.run instructions must be a string when provided')
  }
  const agent = context.agent
  if (agent.status !== 'running') {
    return ok({
      scheduled: false,
      reason: 'no active turn; compaction can only be requested while a turn is running',
    })
  }
  const key = String(agent.id)
  state.pending.set(key, instructions)
  if (!state.draining.has(key)) {
    state.draining.add(key)
    const retire = (): void => {
      state.draining.delete(key)
    }
    // Both branches retire without rethrowing; a rejected drain also drops the
    // pending request so compact.status no longer reports it scheduled.
    void drainPending(deps, state, key, agent, context.signal).then(retire, () => {
      state.pending.delete(key)
      retire()
    })
  }
  return ok({
    scheduled: true,
    note: 'Compaction runs when the current turn ends; the summary replaces older history. Continue working normally.',
  })
}

/** Read the current pressure, or null when the meter cannot measure. */
function measureTokens(deps: CompactBindingDeps, session: Session): number | null {
  try {
    return deps.usage.measure(session).totalTokens
  } catch {
    return null
  }
}

/** Resolve the usable context window of the calling agent's route, or null when unknown. */
async function resolveContextWindow(
  deps: CompactBindingDeps,
  agent: Agent,
  signal: AbortSignal,
): Promise<number | null> {
  const provider = agent.options.provider
  const model = agent.options.model
  if (provider === undefined || model === undefined) return null
  try {
    const info = await deps.models.resolveModelInfo(provider, model, signal)
    const window = info.context?.contextWindow
    return window !== undefined && window > 0 ? window : null
  } catch {
    return null
  }
}

/** Answer `compact.status` with the reference host's field shape. */
async function runCompactStatus(
  deps: CompactBindingDeps,
  state: CompactState,
  context: RlmHostRequestContext,
): Promise<RlmHostReplyData> {
  const tokens = measureTokens(deps, context.agent.session)
  const contextWindow = await resolveContextWindow(deps, context.agent, context.signal)
  const percent = tokens !== null && contextWindow !== null ? (tokens / contextWindow) * 100 : null
  return ok({
    tokens,
    context_window: contextWindow,
    percent,
    scheduled: state.pending.has(String(context.agent.id)),
  })
}

/**
 * Assemble the two host handlers the compact skill answers.
 *
 * @param deps - the composition services captured at load.
 * @returns the handler map to register on `ctx.rlmKernel`.
 */
export function createCompactHostHandlers(deps: CompactBindingDeps): RlmHostRequestHandlers {
  const state: CompactState = { pending: new Map(), draining: new Set() }
  return {
    'compact.run': (request, context) => Promise.resolve(runCompact(deps, state, request, context)),
    'compact.status': (_request, context) => runCompactStatus(deps, state, context),
  }
}
