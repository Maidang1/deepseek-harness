/**
 * Pure folds over one child session's event cut. The bindings read each child
 * through `ctx.sessionQuery`, and this module turns the raw events plus the
 * `subagentTiming` projection into the bounded facts the roster rows carry.
 *
 * @module @deepseek-ai/dsh-rlm-bindings/child-facts
 */

import type { AssistantMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { SubagentTimingProjection } from '@deepseek-ai/dsh-subagent'
import { compactRlmText } from './read.ts'

/** A running child with no tracked activity for this long reports staleness. */
export const RLM_CHILD_STALE_ACTIVITY_THRESHOLD_MS = 10 * 60_000

/** Facts folded from one child session's event cut and timing projection. */
export interface ChildFacts {
  /** True while the child has an open turn — the authoritative running signal. */
  readonly running: boolean
  /** Whether the latest closed turn completed normally, when one has closed. */
  readonly lastTurnCompleted?: boolean
  /** Accumulated turn time in milliseconds, including the open turn's cut span. */
  readonly durationMs?: number
  /** Count of `tool/call` events, omitted while zero. */
  readonly toolUseCount?: number
  /** Compacted text of the last non-empty assistant message. */
  readonly answerPreview?: string
  /** Whether the last assistant message is newer than the last user message. */
  readonly repliedSinceTask?: boolean
  /** Wall-clock time of the child log's last event. */
  readonly lastActivityAt?: number
  /** Why the latest closed turn ended, when it ended abnormally. */
  readonly error?: string
}

/** Join the text blocks of one assistant message. */
function readAssistantText(message: AssistantMessage): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * Human-readable account of one abnormally ended turn, for `collect` rows.
 *
 * @param reason - the closing turn's end reason, when the log recorded one.
 * @returns the error text for the row.
 */
export function formatTurnEndError(reason: TurnEndReason | undefined): string {
  if (reason === undefined) return 'the turn ended without a recorded reason'
  switch (reason.kind) {
    case 'completed': return 'the turn ended unexpectedly'
    case 'aborted': return `the turn was aborted (${reason.reason.kind})`
    case 'blocked': return 'the turn was blocked'
    case 'error': return reason.error.message
    case 'max-tokens': return 'the turn hit the output token ceiling'
    case 'interrupted': return 'the turn was interrupted'
    case 'forked': return 'the turn was left open at a fork boundary'
    default: return 'the turn ended abnormally'
  }
}

/**
 * Lazily computed staleness for a running child: how long since the last
 * tracked activity, once past the threshold. The smaller of the wall and
 * monotonic deltas bounds the value to time the host was actually awake, so a
 * laptop sleep cannot inflate it. Computed at snapshot build time only.
 *
 * @param running - whether the child currently has an open turn.
 * @param lastActivityAt - wall-clock time of the child log's last event.
 * @param lastActivityMonotonicAt - monotonic stamp taken when that event was first observed.
 * @returns whole milliseconds of staleness at or over the threshold, else `undefined`.
 */
export function rlmActivityStaleMs(
  running: boolean,
  lastActivityAt: number | undefined,
  lastActivityMonotonicAt: number | undefined,
): number | undefined {
  if (!running || lastActivityAt === undefined) return undefined
  const wallStaleMs = Date.now() - lastActivityAt
  const monotonicStaleMs =
    lastActivityMonotonicAt === undefined ? wallStaleMs : performance.now() - lastActivityMonotonicAt
  const staleMs = Math.floor(Math.min(wallStaleMs, monotonicStaleMs))
  return staleMs >= RLM_CHILD_STALE_ACTIVITY_THRESHOLD_MS ? staleMs : undefined
}

/**
 * Fold one child session's event cut and timing projection into roster facts.
 *
 * @param events - the child log's events at the observation cut.
 * @param timing - the `subagentTiming` projection at the same cut, when mounted.
 * @returns the folded facts; absent fields are omitted, never `undefined`-valued.
 */
export function foldChildFacts(
  events: readonly SessionEvent[],
  timing: SubagentTimingProjection | undefined,
): ChildFacts {
  let toolUseCount = 0
  let answerPreview: string | undefined
  let lastAssistantSeq = -1
  let lastUserSeq = -1
  let lastTurnEnd: TurnEndReason | undefined
  for (const event of events) {
    if (event.type === 'tool/call') {
      toolUseCount += 1
    } else if (event.type === 'assistant/message') {
      const text = compactRlmText(readAssistantText(event.data.message))
      if (text.length > 0) answerPreview = text
      lastAssistantSeq = event.seq
    } else if (event.type === 'user/message') {
      lastUserSeq = event.seq
    } else if (event.type === 'turn/end') {
      lastTurnEnd = event.data.reason
    }
  }
  const running = timing?.active !== undefined
  const durationMs = timing === undefined
    ? undefined
    : timing.settledMs + (timing.active === undefined ? 0 : Math.max(0, timing.active.through - timing.active.since))
  const lastActivityAt = events.at(-1)?.time
  const error = running || timing?.lastTurnCompleted !== false ? undefined : formatTurnEndError(lastTurnEnd)
  return {
    running,
    ...timing?.lastTurnCompleted === undefined ? {} : { lastTurnCompleted: timing.lastTurnCompleted },
    ...durationMs === undefined ? {} : { durationMs },
    ...toolUseCount === 0 ? {} : { toolUseCount },
    ...answerPreview === undefined ? {} : { answerPreview },
    ...lastAssistantSeq < 0 ? {} : { repliedSinceTask: lastAssistantSeq > lastUserSeq },
    ...lastActivityAt === undefined ? {} : { lastActivityAt },
    ...error === undefined ? {} : { error },
  }
}
