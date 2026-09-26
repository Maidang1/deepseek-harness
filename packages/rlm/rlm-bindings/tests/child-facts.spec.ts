import { describe, expect, it } from 'vitest'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { SubagentTimingProjection } from '@deepseek-ai/dsh-subagent'
import {
  foldChildFacts,
  formatTurnEndError,
  RLM_CHILD_STALE_ACTIVITY_THRESHOLD_MS,
  rlmActivityStaleMs,
} from '../src/child-facts.ts'

function assistantMessage(text: string): AssistantMessage {
  return {
    id: MessageId('m1'),
    role: 'assistant',
    content: text.length === 0 ? [] : [{ type: 'text', text }],
    source: { kind: 'model', provider: 'p', model: 'm' },
  }
}

function userMessage(text: string): UserMessage {
  return {
    id: MessageId('m2'),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function turnStart(seq: number, time: number): SessionEvent {
  return { type: 'turn/start', seq: SessionSeq(seq), time, data: { turn: 1 } }
}

function turnEnd(seq: number, time: number, reason: TurnEndReason): SessionEvent {
  return { type: 'turn/end', seq: SessionSeq(seq), time, data: { turn: 1, reason } }
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
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    time,
    data: userMessage(text),
    surfaceOp: 'append',
  }
}

describe('foldChildFacts', () => {
  it('folds an empty log with no timing', () => {
    expect(foldChildFacts([], undefined)).toEqual({ running: false })
  })

  it('marks a child with an open turn running and adds the open span to the duration', () => {
    const timing: SubagentTimingProjection = { settledMs: 500, active: { since: 1000, through: 1800 } }
    const facts = foldChildFacts([turnStart(0, 1000), assistant(1, 1500, 'working')], timing)
    expect(facts).toEqual({
      running: true,
      durationMs: 1300,
      answerPreview: 'working',
      repliedSinceTask: true,
      lastActivityAt: 1500,
    })
  })

  it('marks a child whose last turn completed as settled', () => {
    const timing: SubagentTimingProjection = { settledMs: 42, lastTurnCompleted: true }
    const facts = foldChildFacts(
      [user(0, 100, 'do it'), toolCall(1, 200), toolCall(2, 300), assistant(3, 400, 'done')],
      timing,
    )
    expect(facts).toEqual({
      running: false,
      lastTurnCompleted: true,
      durationMs: 42,
      toolUseCount: 2,
      answerPreview: 'done',
      repliedSinceTask: true,
      lastActivityAt: 400,
    })
  })

  it('reports the error of an abnormally ended turn', () => {
    const timing: SubagentTimingProjection = { settledMs: 7, lastTurnCompleted: false }
    const events = [turnStart(0, 0), turnEnd(1, 7, { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } })]
    expect(foldChildFacts(events, timing)).toEqual({
      running: false,
      lastTurnCompleted: false,
      durationMs: 7,
      lastActivityAt: 7,
      error: 'boom',
    })
  })

  it('keeps a running child free of an error even after an earlier failed turn', () => {
    const timing: SubagentTimingProjection = { settledMs: 7, active: { since: 10, through: 12 }, lastTurnCompleted: false }
    const facts = foldChildFacts([turnEnd(0, 7, { kind: 'interrupted' })], timing)
    expect(facts.running).toBe(true)
    expect(facts.error).toBeUndefined()
  })

  it('skips empty assistant text for the preview but still tracks the reply order', () => {
    const withReasoning: SessionEvent = {
      type: 'assistant/message',
      seq: SessionSeq(1),
      time: 200,
      data: {
        turn: 1,
        step: 0,
        message: { ...assistantMessage(''), content: [{ type: 'reasoning', text: 'hmm' }] },
        stream: [],
      },
      surfaceOp: 'append',
    }
    const facts = foldChildFacts([assistant(0, 100, ''), withReasoning], undefined)
    expect(facts.answerPreview).toBeUndefined()
    expect(facts.repliedSinceTask).toBe(true)
  })

  it('reports an unanswered user message as not replied', () => {
    const facts = foldChildFacts([assistant(0, 100, 'hi'), user(1, 200, 'again?')], undefined)
    expect(facts.repliedSinceTask).toBe(false)
  })
})

describe('formatTurnEndError', () => {
  it('names each known reason', () => {
    expect(formatTurnEndError(undefined)).toBe('the turn ended without a recorded reason')
    expect(formatTurnEndError({ kind: 'completed' })).toBe('the turn ended unexpectedly')
    expect(formatTurnEndError({ kind: 'aborted', reason: { kind: 'user' } })).toBe('the turn was aborted (user)')
    expect(formatTurnEndError({ kind: 'blocked' })).toBe('the turn was blocked')
    expect(formatTurnEndError({ kind: 'error', error: { message: 'nope', code: 'X' } })).toBe('nope')
    expect(formatTurnEndError({ kind: 'max-tokens' })).toBe('the turn hit the output token ceiling')
    expect(formatTurnEndError({ kind: 'interrupted' })).toBe('the turn was interrupted')
    expect(formatTurnEndError({ kind: 'forked' })).toBe('the turn was left open at a fork boundary')
  })

  it('falls through an unknown reason kind', () => {
    expect(formatTurnEndError({ kind: 'something-new' } as never)).toBe('the turn ended abnormally')
  })
})

describe('rlmActivityStaleMs', () => {
  it('is undefined for a settled child or one without tracked activity', () => {
    expect(rlmActivityStaleMs(false, Date.now() - 10_000_000, undefined)).toBeUndefined()
    expect(rlmActivityStaleMs(true, undefined, undefined)).toBeUndefined()
  })

  it('reports whole milliseconds once past the threshold, bounded by the monotonic clock', () => {
    const wallOld = Date.now() - RLM_CHILD_STALE_ACTIVITY_THRESHOLD_MS - 60_000
    const stale = rlmActivityStaleMs(true, wallOld, undefined)
    expect(stale).toBeGreaterThanOrEqual(RLM_CHILD_STALE_ACTIVITY_THRESHOLD_MS)
    expect(Number.isInteger(stale)).toBe(true)
  })

  it('stays silent under the threshold on either clock', () => {
    expect(rlmActivityStaleMs(true, Date.now() - 1000, undefined)).toBeUndefined()
    const monotonicFresh = performance.now() - 1000
    expect(rlmActivityStaleMs(true, Date.now() - 10_000_000, monotonicFresh)).toBeUndefined()
  })
})
