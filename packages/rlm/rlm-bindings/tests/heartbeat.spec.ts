import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { RlmHostReplyData, RlmHostRequestContext, RlmHostRequestEvent } from '@deepseek-ai/dsh-rlm-kernel'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  HeartbeatScheduler,
  HeartbeatStore,
  createHeartbeatHostHandlers,
  createHeartbeatMessage,
  formatHeartbeatPrompt,
  heartbeatWireRow,
  nextRunAtForSchedule,
  normalizeHeartbeatDeliveryMode,
  normalizeHeartbeatSchedule,
  parseHeartbeatSchedule,
} from '../src/heartbeat.ts'
import type { HeartbeatDeliveryTarget, HeartbeatJob, HeartbeatWireRow } from '../src/heartbeat.ts'

const FIXED = new Date('2031-03-04T05:06:07.000Z')

function agent(id: string): Agent {
  const session = Session.create(SessionId(id), [], {
    version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 0, cwd: '/repo', isSeeded: false,
  })
  return {
    id: SessionId(id),
    options: {},
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

/** Invoke a handler so a synchronous validation throw surfaces as a rejection. */
async function call(
  handler: (request: RlmHostRequestEvent, context: RlmHostRequestContext) => Promise<unknown>,
  req: RlmHostRequestEvent,
  ctx: RlmHostRequestContext,
): Promise<unknown> {
  return handler(req, ctx)
}

/** Unwrap an ok reply, failing the test on an error reply. */
function okResult(reply: RlmHostReplyData): JsonValue {
  if (reply.status !== 'ok') throw new Error('expected an ok reply')
  return reply.result
}

function storePath(): { dir: string; file: string; store: HeartbeatStore } {
  const dir = mkdtempSync(join(tmpdir(), 'rlm-hb-'))
  const file = join(dir, 'heartbeats.json')
  return { dir, file, store: new HeartbeatStore(file) }
}

class FakeTarget implements HeartbeatDeliveryTarget {
  readonly steered: UserMessage[] = []
  readonly followups: UserMessage[] = []
  failSteer: unknown

  steer(message: UserMessage): void {
    if (this.failSteer !== undefined) throw this.failSteer
    this.steered.push(message)
  }

  followup(message: UserMessage): void {
    this.followups.push(message)
  }
}

describe('parseHeartbeatSchedule', () => {
  it('rejects empty schedule text', () => {
    expect(() => parseHeartbeatSchedule('   ', FIXED)).toThrow('Cron schedule cannot be empty')
  })

  it('parses a quoted interval and defaults the clock', () => {
    const parsed = parseHeartbeatSchedule('"every 5m"')
    expect(parsed.schedule).toEqual({ kind: 'interval', expression: 'every 5m', intervalMs: 300_000 })
    expect(parsed.nextRunAt.getTime()).toBeGreaterThan(Date.now())
    expect(parseHeartbeatSchedule("'every 5m'", FIXED).schedule)
      .toEqual({ kind: 'interval', expression: 'every 5m', intervalMs: 300_000 })
  })

  it('parses one-shot delays in minutes, hours, and days', () => {
    expect(parseHeartbeatSchedule('in 10m', FIXED).nextRunAt.getTime()).toBe(FIXED.getTime() + 600_000)
    expect(parseHeartbeatSchedule('in 2 hours', FIXED).nextRunAt.getTime()).toBe(FIXED.getTime() + 7_200_000)
    const daily = parseHeartbeatSchedule('in 1 day', FIXED)
    expect(daily.schedule).toEqual({ kind: 'once', expression: 'in 1 day' })
    expect(daily.nextRunAt.getTime()).toBe(FIXED.getTime() + 86_400_000)
  })

  it('parses recurring intervals in seconds, minutes, and hours', () => {
    expect(parseHeartbeatSchedule('every 30s', FIXED).schedule)
      .toEqual({ kind: 'interval', expression: 'every 30s', intervalMs: 30_000 })
    expect(parseHeartbeatSchedule('each 2 hours', FIXED).schedule)
      .toEqual({ kind: 'interval', expression: 'each 2 hours', intervalMs: 7_200_000 })
  })

  it('rejects recurring intervals below ten seconds', () => {
    expect(() => parseHeartbeatSchedule('every 5s', FIXED))
      .toThrow('Recurring interval must be at least 10 seconds')
  })

  it('parses absolute one-shot schedules and rejects bad ones', () => {
    const when = new Date(FIXED.getTime() + 3_600_000)
    expect(parseHeartbeatSchedule(`at ${when.toISOString()}`, FIXED).nextRunAt.getTime()).toBe(when.getTime())
    expect(() => parseHeartbeatSchedule('at not-a-date', FIXED))
      .toThrow('Invalid one-shot schedule. Use: at <ISO date>')
    expect(() => parseHeartbeatSchedule(`at ${new Date(FIXED.getTime() - 1000).toISOString()}`, FIXED))
      .toThrow('One-shot schedule must be in the future')
  })

  it('expands cron aliases and validates field count', () => {
    expect(parseHeartbeatSchedule('@daily', FIXED).schedule).toEqual({ kind: 'cron', expression: '0 0 * * *' })
    expect(parseHeartbeatSchedule('@hourly', FIXED).schedule).toEqual({ kind: 'cron', expression: '0 * * * *' })
    expect(parseHeartbeatSchedule('@weekly', FIXED).schedule).toEqual({ kind: 'cron', expression: '0 0 * * 0' })
    expect(parseHeartbeatSchedule('@monthly', FIXED).schedule).toEqual({ kind: 'cron', expression: '0 0 1 * *' })
    expect(() => parseHeartbeatSchedule('0 0 * *', FIXED)).toThrow('Unsupported cron schedule')
    expect(() => parseHeartbeatSchedule('x', FIXED)).toThrow('Unsupported cron schedule')
  })

  it('rejects cron expressions that never match within a year', () => {
    expect(() => parseHeartbeatSchedule('0 0 31 2 *', FIXED))
      .toThrow('Cron schedule did not match within one year: 0 0 31 2 *')
  })

  it('rejects malformed cron fields with the reference messages', () => {
    expect(() => parseHeartbeatSchedule('x * * * *', FIXED)).toThrow('Invalid cron number: x')
    expect(() => parseHeartbeatSchedule('70 * * * *', FIXED)).toThrow('Cron number out of range: 70')
    expect(() => parseHeartbeatSchedule('5-2 * * * *', FIXED)).toThrow('Invalid cron range: 5-2')
    expect(() => parseHeartbeatSchedule('*/0 * * * *', FIXED)).toThrow('Cron number out of range: 0')
    expect(() => parseHeartbeatSchedule('1,,2 * * * *', FIXED)).toThrow('Invalid cron field: 1,,2')
    expect(() => parseHeartbeatSchedule('/5 * * * *', FIXED)).toThrow('Invalid cron number: ')
  })

  it('finds the next matching minute, weekday seven, and weekday zero', () => {
    const from = new Date(2031, 2, 4, 10, 7, 30)
    const stepped = parseHeartbeatSchedule('*/15 * * * *', from).nextRunAt
    expect(stepped.getMinutes()).toBe(15)
    expect(stepped.getHours()).toBe(10)

    const seven = parseHeartbeatSchedule('0 0 * * 7', from).nextRunAt
    expect(seven.getDay()).toBe(0)
    expect(seven.getHours()).toBe(0)
    expect(seven.getTime()).toBeGreaterThan(from.getTime())

    const zero = parseHeartbeatSchedule('0 0 * * 0', from).nextRunAt
    expect(zero.getDay()).toBe(0)
    expect(zero.getTime()).toBeGreaterThan(from.getTime())
  })

  it('honors comma lists, ranges, steps, and calendar fields', () => {
    const from = new Date(2031, 0, 1, 0, 0, 0)
    const listed = parseHeartbeatSchedule('1,2,3 * * * *', from).nextRunAt
    expect(listed.getMinutes()).toBe(1)
    const ranged = parseHeartbeatSchedule('5-10/2 * * * *', from).nextRunAt
    expect(ranged.getMinutes()).toBe(5)
    const trailing = parseHeartbeatSchedule('1-7-3 * * * *', from).nextRunAt
    expect(trailing.getMinutes()).toBe(1)
    const calendared = parseHeartbeatSchedule('30 9 15 6 *', from).nextRunAt
    expect(calendared.getMonth()).toBe(5)
    expect(calendared.getDate()).toBe(15)
    expect(calendared.getHours()).toBe(9)
    expect(calendared.getMinutes()).toBe(30)
  })
})

describe('normalizeHeartbeatSchedule', () => {
  it('defaults, prefixes bare durations, and passes other text through', () => {
    expect(normalizeHeartbeatSchedule(undefined)).toBe('every 5m')
    expect(normalizeHeartbeatSchedule('   ')).toBe('every 5m')
    expect(normalizeHeartbeatSchedule('5m')).toBe('every 5m')
    expect(normalizeHeartbeatSchedule('every 10s')).toBe('every 10s')
    expect(normalizeHeartbeatSchedule('0 0 * * *')).toBe('0 0 * * *')
  })
})

describe('normalizeHeartbeatDeliveryMode', () => {
  it('passes undefined and null through, validates the vocabulary', () => {
    expect(normalizeHeartbeatDeliveryMode(undefined)).toBeUndefined()
    expect(normalizeHeartbeatDeliveryMode(null)).toBeUndefined()
    expect(normalizeHeartbeatDeliveryMode('steer')).toBe('steer')
    expect(normalizeHeartbeatDeliveryMode('follow_up')).toBe('follow_up')
    expect(() => normalizeHeartbeatDeliveryMode('loud'))
      .toThrow('Heartbeat delivery mode must be "steer" or "follow_up"')
    expect(() => normalizeHeartbeatDeliveryMode(5))
      .toThrow('Heartbeat delivery mode must be "steer" or "follow_up"')
  })
})

describe('nextRunAtForSchedule', () => {
  it('advances intervals and delegates cron rules', () => {
    expect(nextRunAtForSchedule({ kind: 'interval', expression: 'every 5m', intervalMs: 300_000 }, FIXED).getTime())
      .toBe(FIXED.getTime() + 300_000)
    const cron = nextRunAtForSchedule({ kind: 'cron', expression: '0 * * * *' }, new Date(2031, 2, 4, 10, 7, 0))
    expect(cron.getMinutes()).toBe(0)
    expect(cron.getTime()).toBeGreaterThan(new Date(2031, 2, 4, 10, 7, 0).getTime())
  })
})

describe('HeartbeatStore', () => {
  it('creates an active heartbeat with defaults and persists it', () => {
    const { store, file } = storePath()
    const job = store.create({ sessionId: 's1', instruction: '  check in  ', now: FIXED })
    expect(job.id).toBeDefined()
    expect(job.status).toBe('active')
    expect(job.deliveryMode).toBe('steer')
    expect(job.instruction).toBe('check in')
    expect(job.schedule).toEqual({ kind: 'interval', expression: 'every 5m', intervalMs: 300_000 })
    expect(job.nextRunAt).toBe('2031-03-04T05:11:07.000Z')
    expect(job.runCount).toBe(0)
    expect(job.label).toBeUndefined()
    const reloaded = new HeartbeatStore(file)
    expect(reloaded.list('s1')).toEqual([job])
  })

  it('trims and drops blank labels, stores explicit delivery modes', () => {
    const { store } = storePath()
    const labelled = store.create({ sessionId: 's1', instruction: 'a', label: '  nightly  ', deliveryMode: 'follow_up', now: FIXED })
    expect(labelled.label).toBe('nightly')
    expect(labelled.deliveryMode).toBe('follow_up')
    const blank = store.create({ sessionId: 's1', instruction: 'b', label: '   ', now: FIXED })
    expect(blank.label).toBeUndefined()
  })

  it('normalizes bare durations and rejects empty instructions and one-shots', () => {
    const { store } = storePath()
    const job = store.create({ sessionId: 's1', instruction: 'a', interval: '30s', now: FIXED })
    expect(job.schedule).toEqual({ kind: 'interval', expression: 'every 30s', intervalMs: 30_000 })
    const wallClock = store.create({ sessionId: 's1', instruction: 'wall' })
    expect(wallClock.nextRunAt).toBeDefined()
    expect(() => store.create({ sessionId: 's1', instruction: '   ', now: FIXED }))
      .toThrow('RLM heartbeat instruction cannot be empty')
    expect(() => store.create({ sessionId: 's1', instruction: 'a', interval: 'in 10m', now: FIXED }))
      .toThrow('RLM heartbeat schedule must be recurring')
  })

  it('lists per session, soonest first, paused and cancelled last', () => {
    const { store } = storePath()
    const late = store.create({ sessionId: 's1', instruction: 'late', interval: 'every 2h', now: FIXED })
    const early = store.create({ sessionId: 's1', instruction: 'early', interval: 'every 30s', now: FIXED })
    const pausedA = store.create({ sessionId: 's1', instruction: 'paused-a', now: FIXED })
    const pausedB = store.create({ sessionId: 's1', instruction: 'paused-b', now: FIXED })
    store.update('s1', pausedA.id, { status: 'pause', now: FIXED })
    store.update('s1', pausedB.id, { status: 'pause', now: FIXED })
    const cancelled = store.create({ sessionId: 's1', instruction: 'cancelled', now: FIXED })
    store.delete('s1', cancelled.id, FIXED)
    store.create({ sessionId: 's2', instruction: 'other', now: FIXED })
    expect(store.list('s1').map(job => job.instruction)).toEqual(['early', 'late', 'paused-a', 'paused-b'])
    expect(store.list('s1', { includeInactive: true }).map(job => job.instruction))
      .toEqual(['early', 'late', 'paused-a', 'paused-b', 'cancelled'])
    expect(store.list('s2')).toHaveLength(1)
    expect(store.list('s3')).toEqual([])
    expect(late.nextRunAt).toBeDefined()
    expect(early.nextRunAt).toBeDefined()
  })

  it('updates fields, pauses and resumes, and leaves cancelled rows alone', () => {
    const { store } = storePath()
    const job = store.create({ sessionId: 's1', instruction: 'a', now: FIXED })
    const labelled = store.update('s1', job.id, { label: 'nightly', deliveryMode: 'follow_up', now: FIXED })
    expect(labelled?.label).toBe('nightly')
    expect(labelled?.deliveryMode).toBe('follow_up')
    const reworded = store.update('s1', job.id, { instruction: '  b  ', now: FIXED })
    expect(reworded?.instruction).toBe('b')
    const rescheduled = store.update('s1', job.id, { interval: 'every 30s', now: FIXED })
    expect(rescheduled?.schedule).toEqual({ kind: 'interval', expression: 'every 30s', intervalMs: 30_000 })
    expect(rescheduled?.nextRunAt).toBe('2031-03-04T05:06:37.000Z')
    const cleared = store.update('s1', job.id, { label: '   ', now: FIXED })
    expect(cleared?.label).toBeUndefined()
    const wallClock = store.update('s1', job.id, { label: 'wall' })
    expect(wallClock?.label).toBe('wall')

    const paused = store.update('s1', job.id, { status: 'pause', now: FIXED })
    expect(paused?.status).toBe('paused')
    expect(paused?.nextRunAt).toBeUndefined()
    const reinterval = store.update('s1', job.id, { interval: 'every 2h', now: FIXED })
    expect(reinterval?.status).toBe('paused')
    expect(reinterval?.nextRunAt).toBeUndefined()
    expect(reinterval?.schedule).toEqual({ kind: 'interval', expression: 'every 2h', intervalMs: 7_200_000 })
    const resumed = store.update('s1', job.id, { status: 'resume', now: FIXED })
    expect(resumed?.status).toBe('active')
    expect(resumed?.nextRunAt).toBe('2031-03-04T07:06:07.000Z')

    expect(store.update('s1', 'missing', { label: 'x', now: FIXED })).toBeUndefined()
    expect(store.update('s2', job.id, { label: 'x', now: FIXED })).toBeUndefined()
    store.delete('s1', job.id, FIXED)
    expect(store.update('s1', job.id, { label: 'x', now: FIXED })).toBeUndefined()
    expect(store.list('s1', { includeInactive: true })[0]?.updatedAt).toBe(FIXED.toISOString())
  })

  it('rejects empty instructions and one-shot intervals on update', () => {
    const { store } = storePath()
    const job = store.create({ sessionId: 's1', instruction: 'a', now: FIXED })
    expect(() => store.update('s1', job.id, { instruction: '  ', now: FIXED }))
      .toThrow('RLM heartbeat instruction cannot be empty')
    expect(() => store.update('s1', job.id, { interval: 'at 2031-03-04T06:00:00.000Z', now: FIXED }))
      .toThrow('RLM heartbeat schedule must be recurring')
  })

  it('deletes by cancelling, and returns undefined for unknown ids', () => {
    const { store } = storePath()
    const job = store.create({ sessionId: 's1', instruction: 'a', now: FIXED })
    const deleted = store.delete('s1', job.id)
    expect(deleted?.status).toBe('cancelled')
    expect(deleted?.nextRunAt).toBeUndefined()
    expect(store.delete('s1', 'missing', FIXED)).toBeUndefined()
    expect(store.delete('s2', job.id, FIXED)).toBeUndefined()
    const again = store.delete('s1', job.id, FIXED)
    expect(again?.status).toBe('cancelled')
  })

  it('cancels every live heartbeat of one session', () => {
    const { store } = storePath()
    const active = store.create({ sessionId: 's1', instruction: 'a', now: FIXED })
    const paused = store.create({ sessionId: 's1', instruction: 'b', now: FIXED })
    store.update('s1', paused.id, { status: 'pause', now: FIXED })
    store.create({ sessionId: 's2', instruction: 'c', now: FIXED })
    const cancelled = store.cancelSession('s1')
    expect(cancelled.map(job => job.id)).toEqual([active.id, paused.id])
    expect(store.list('s1')).toEqual([])
    expect(store.list('s1', { includeInactive: true })).toHaveLength(2)
    expect(store.list('s2')).toHaveLength(1)
    expect(store.cancelSession('s1', FIXED)).toEqual([])
  })

  it('reports the earliest active run and the due set', () => {
    const { store } = storePath()
    expect(store.nextActiveRunAt()).toBeUndefined()
    const late = store.create({ sessionId: 's1', instruction: 'late', interval: 'every 2h', now: FIXED })
    const early = store.create({ sessionId: 's1', instruction: 'early', interval: 'every 30s', now: FIXED })
    const paused = store.create({ sessionId: 's1', instruction: 'paused', now: FIXED })
    store.update('s1', paused.id, { status: 'pause', now: FIXED })
    expect(store.nextActiveRunAt()).toBe(Date.parse(early.nextRunAt!))
    const due = store.dueJobs(new Date(FIXED.getTime() + 3 * 3_600_000))
    expect(due.map(job => job.id)).toEqual([early.id, late.id])
    expect(store.dueJobs(FIXED)).toEqual([])
  })

  it('records runs: counts, timestamps, error clearing, and schedule advance', () => {
    const { store } = storePath()
    const job = store.create({ sessionId: 's1', instruction: 'a', interval: 'every 30s', now: FIXED })
    const failed = store.recordRun(job.id, { now: FIXED, error: new Error('boom') })
    expect(failed?.runCount).toBe(1)
    expect(failed?.lastRunAt).toBe(FIXED.toISOString())
    expect(failed?.lastError).toBe('boom')
    expect(failed?.nextRunAt).toBe('2031-03-04T05:06:37.000Z')
    const textFailed = store.recordRun(job.id, { now: FIXED, error: 'plain text' })
    expect(textFailed?.lastError).toBe('plain text')
    const succeeded = store.recordRun(job.id, {})
    expect(succeeded?.runCount).toBe(3)
    expect(succeeded?.lastError).toBeUndefined()
    store.update('s1', job.id, { status: 'pause', now: FIXED })
    expect(store.recordRun(job.id, { now: FIXED })).toBeUndefined()
    expect(store.recordRun('missing', { now: FIXED })).toBeUndefined()
  })

  it('records skips: schedule advances, error lands, counters stay', () => {
    const { store } = storePath()
    const job = store.create({ sessionId: 's1', instruction: 'a', interval: 'every 30s', now: FIXED })
    const before = Date.now()
    const skipped = store.recordSkip(job.id, 'not live')
    expect(skipped?.lastError).toBe('not live')
    expect(skipped?.runCount).toBe(0)
    expect(skipped?.lastRunAt).toBeUndefined()
    expect(Date.parse(skipped!.nextRunAt!)).toBeGreaterThanOrEqual(before + 29_000)
    expect(Date.parse(skipped!.nextRunAt!)).toBeLessThanOrEqual(Date.now() + 30_001)
    store.update('s1', job.id, { status: 'pause', now: FIXED })
    expect(store.recordSkip(job.id, 'not live', FIXED)).toBeUndefined()
    expect(store.recordSkip('missing', 'not live', FIXED)).toBeUndefined()
  })

  it('reads a missing file as empty and rejects corrupt stores', () => {
    const { store, file } = storePath()
    expect(store.list('s1')).toEqual([])
    writeFileSync(file, 'not json', 'utf8')
    expect(() => store.list('s1')).toThrow('is corrupt')
    writeFileSync(file, '[]', 'utf8')
    expect(() => store.list('s1')).toThrow('is corrupt')
    writeFileSync(file, '{"jobs":{}}', 'utf8')
    expect(() => store.list('s1')).toThrow('is corrupt')
  })

  it('rejects malformed rows one field at a time', () => {
    const valid = {
      id: 'hb-1',
      sessionId: 's1',
      status: 'active',
      deliveryMode: 'steer',
      instruction: 'a',
      schedule: { kind: 'interval', expression: 'every 5m', intervalMs: 300_000 },
      createdAt: FIXED.toISOString(),
      updatedAt: FIXED.toISOString(),
      nextRunAt: FIXED.toISOString(),
      runCount: 0,
    }
    const fixtures: unknown[] = [
      42,
      { ...valid, id: 1 },
      { ...valid, status: 'done' },
      { ...valid, deliveryMode: 'loud' },
      { ...valid, createdAt: 1 },
      { ...valid, runCount: '0' },
      { ...valid, runCount: 1.5 },
      { ...valid, label: 7 },
      { ...valid, nextRunAt: 7 },
      { ...valid, lastRunAt: 7 },
      { ...valid, lastError: 7 },
      { ...valid, schedule: 'x' },
      { ...valid, schedule: { kind: 'interval', expression: 5, intervalMs: 300_000 } },
      { ...valid, schedule: { kind: 'interval', expression: 'every 5m', intervalMs: 'x' } },
      { ...valid, schedule: { kind: 'interval', expression: 'every 5m', intervalMs: 1.5 } },
      { ...valid, schedule: { kind: 'interval', expression: 'every 5m', intervalMs: 0 } },
      { ...valid, schedule: { kind: 'once', expression: 'in 5m' } },
    ]
    for (const fixture of fixtures) {
      const { store, file } = storePath()
      writeFileSync(file, JSON.stringify({ jobs: [fixture] }), 'utf8')
      expect(() => store.list('s1')).toThrow('is corrupt')
    }
  })

  it('round-trips optional fields through persistence', () => {
    const { store, file } = storePath()
    const job = store.create({ sessionId: 's1', instruction: 'a', label: 'nightly', now: FIXED })
    store.recordRun(job.id, { now: FIXED, error: new Error('boom') })
    const reloaded = new HeartbeatStore(file)
    const row = reloaded.list('s1')[0]!
    expect(row.label).toBe('nightly')
    expect(row.lastRunAt).toBe(FIXED.toISOString())
    expect(row.lastError).toBe('boom')
    expect(row.runCount).toBe(1)
  })
})

describe('heartbeat prompts', () => {
  function job(overrides: Partial<HeartbeatJob> = {}): HeartbeatJob {
    return {
      id: 'hb-1',
      sessionId: 's1',
      status: 'active',
      deliveryMode: 'steer',
      instruction: 'check the queue',
      schedule: { kind: 'interval', expression: 'every 5m', intervalMs: 300_000 },
      createdAt: FIXED.toISOString(),
      updatedAt: FIXED.toISOString(),
      nextRunAt: FIXED.toISOString(),
      runCount: 2,
      ...overrides,
    }
  }

  it('formats the header line and the instruction', () => {
    expect(formatHeartbeatPrompt(job())).toBe('[heartbeat: every 5m run#2]\n\ncheck the queue')
  })

  it('builds an identified user message stamped with the heartbeat source', () => {
    const message = createHeartbeatMessage(job())
    expect(message.role).toBe('user')
    expect(message.id).toBeDefined()
    expect(message.source).toEqual({ kind: 'rlm-heartbeat' })
    expect(message.content).toEqual([{ type: 'text', text: '[heartbeat: every 5m run#2]\n\ncheck the queue' }])
  })

  it('projects rows onto the wire shape with nulls and conditional interval', () => {
    const row = heartbeatWireRow(job({ label: 'nightly', lastRunAt: FIXED.toISOString(), lastError: 'boom' }))
    expect(row).toEqual({
      id: 'hb-1',
      status: 'active',
      label: 'nightly',
      delivery_mode: 'steer',
      instruction: 'check the queue',
      schedule: { kind: 'interval', expression: 'every 5m', intervalMs: 300_000 },
      created_at: FIXED.toISOString(),
      updated_at: FIXED.toISOString(),
      next_run_at: FIXED.toISOString(),
      last_run_at: FIXED.toISOString(),
      last_error: 'boom',
      run_count: 2,
    })
    const cronRow = heartbeatWireRow(job({ schedule: { kind: 'cron', expression: '0 9 * * *' } }))
    expect(cronRow.schedule).toEqual({ kind: 'cron', expression: '0 9 * * *' })
    expect('intervalMs' in cronRow.schedule).toBe(false)
    const bareRow = heartbeatWireRow(job({}))
    expect(bareRow.label).toBeNull()
    expect(bareRow.last_run_at).toBeNull()
    expect(bareRow.last_error).toBeNull()
  })
})

describe('HeartbeatScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FIXED)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function rig(options: {
    target?: FakeTarget
    resolveAgent?: (sessionId: string) => HeartbeatDeliveryTarget | undefined
    onError?: (error: unknown) => void
    now?: () => Date
  } = {}): { store: HeartbeatStore; file: string; scheduler: HeartbeatScheduler; target: FakeTarget } {
    const { store, file } = storePath()
    const target = options.target ?? new FakeTarget()
    const scheduler = new HeartbeatScheduler({
      store,
      resolveAgent: options.resolveAgent ?? (() => target),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    return { store, file, scheduler, target }
  }

  it('stays idle without jobs, then fires a steered beat on schedule', () => {
    const { scheduler, target } = rig()
    scheduler.start()
    expect(vi.getTimerCount()).toBe(0)
    scheduler.create({ sessionId: 's1', instruction: 'ping', interval: 'every 30s' })
    expect(vi.getTimerCount()).toBe(1)
    return vi.advanceTimersByTimeAsync(30_000).then(() => {
      expect(target.steered).toHaveLength(1)
      expect(target.steered[0]!.content).toEqual([{ type: 'text', text: '[heartbeat: every 30s run#0]\n\nping' }])
      expect(target.steered[0]!.source).toEqual({ kind: 'rlm-heartbeat' })
    }).then(() => vi.advanceTimersByTimeAsync(30_000)).then(() => {
      expect(target.steered).toHaveLength(2)
      expect(target.steered[1]!.content).toEqual([{ type: 'text', text: '[heartbeat: every 30s run#1]\n\nping' }])
      scheduler.dispose()
    })
  })

  it('queues follow_up beats instead of steering', async () => {
    const { scheduler, target } = rig()
    scheduler.create({ sessionId: 's1', instruction: 'ping', interval: 'every 30s', deliveryMode: 'follow_up' })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(target.followups).toHaveLength(1)
    expect(target.steered).toHaveLength(0)
    scheduler.dispose()
  })

  it('records steer failures and clears them on the next success', async () => {
    const { store, scheduler, target } = rig()
    const job = scheduler.create({ sessionId: 's1', instruction: 'ping', interval: 'every 30s' })
    target.failSteer = new Error('driver busy')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(store.list('s1')[0]?.lastError).toBe('driver busy')
    expect(store.list('s1')[0]?.runCount).toBe(1)
    target.failSteer = undefined
    await vi.advanceTimersByTimeAsync(30_000)
    expect(store.list('s1')[0]?.lastError).toBeUndefined()
    expect(store.list('s1')[0]?.runCount).toBe(2)
    expect(job.id).toBeDefined()
    scheduler.dispose()
  })

  it('skips beats whose session is not live and reports the reason', async () => {
    const { store, scheduler } = rig({ resolveAgent: () => undefined })
    scheduler.create({ sessionId: 'gone', instruction: 'ping', interval: 'every 30s' })
    await vi.advanceTimersByTimeAsync(30_000)
    const row = store.list('gone')[0]!
    expect(row.runCount).toBe(0)
    expect(row.lastRunAt).toBeUndefined()
    expect(row.lastError).toBe('RLM heartbeat target session "gone" is not live')
    expect(Date.parse(row.nextRunAt!)).toBeGreaterThan(FIXED.getTime() + 30_000)
    scheduler.dispose()
  })

  it('pauses, resumes, and deletes around the armed timer', async () => {
    const { scheduler, target } = rig()
    const job = scheduler.create({ sessionId: 's1', instruction: 'ping', interval: 'every 30s' })
    scheduler.update('s1', job.id, { status: 'pause' })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(target.steered).toHaveLength(0)
    scheduler.update('s1', job.id, { status: 'resume' })
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(target.steered).toHaveLength(1)
    scheduler.delete('s1', job.id)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(target.steered).toHaveLength(1)
    scheduler.dispose()
  })

  it('cancels a session and ignores unknown sessions', async () => {
    const { scheduler, target } = rig()
    scheduler.create({ sessionId: 's1', instruction: 'ping', interval: 'every 30s' })
    const cancelled = scheduler.cancelSession('s1')
    expect(cancelled).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(scheduler.cancelSession('nobody')).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(target.steered).toHaveLength(0)
    scheduler.dispose()
  })

  it('clamps over-long delays and re-arms without delivering', async () => {
    const { scheduler, target } = rig()
    scheduler.create({ sessionId: 's1', instruction: 'ping', interval: 'every 1000000 hours' })
    await vi.advanceTimersByTimeAsync(2_147_483_647)
    expect(target.steered).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(1)
    scheduler.dispose()
  })

  it('stops firing after dispose, and tolerates disposing an idle scheduler', async () => {
    const { scheduler, target } = rig()
    scheduler.dispose()
    scheduler.create({ sessionId: 's1', instruction: 'ping', interval: 'every 30s' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(target.steered).toHaveLength(0)
    const idle = rig()
    idle.scheduler.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('routes store read failures to onError and keeps going without one', async () => {
    const errors: unknown[] = []
    const { file, scheduler } = rig({ onError: error => errors.push(error) })
    scheduler.create({ sessionId: 's1', instruction: 'ping', interval: 'every 30s' })
    writeFileSync(file, 'not json', 'utf8')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(errors.length).toBeGreaterThan(0)
    expect(vi.getTimerCount()).toBe(0)
    scheduler.dispose()

    const quiet = rig()
    quiet.scheduler.create({ sessionId: 's1', instruction: 'ping', interval: 'every 30s' })
    writeFileSync(quiet.file, 'not json', 'utf8')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(vi.getTimerCount()).toBe(0)
    quiet.scheduler.dispose()
  })

  it('runs against the wall clock when no clock override is given', () => {
    vi.useRealTimers()
    const { store, scheduler } = rig()
    const before = Date.now()
    const job = scheduler.create({ sessionId: 's1', instruction: 'ping' })
    const at = Date.parse(job.nextRunAt!)
    expect(at).toBeGreaterThanOrEqual(before + 299_000)
    expect(at).toBeLessThanOrEqual(Date.now() + 300_001)
    expect(store.list('s1')).toHaveLength(1)
    scheduler.dispose()
    vi.useFakeTimers()
    vi.setSystemTime(FIXED)
  })
})

describe('rlm_heartbeat host handlers', () => {
  function rig(): {
    store: HeartbeatStore
    scheduler: HeartbeatScheduler
    handlers: ReturnType<typeof createHeartbeatHostHandlers>
  } {
    const { store } = storePath()
    const scheduler = new HeartbeatScheduler({
      store,
      resolveAgent: () => undefined,
      now: () => new Date(FIXED),
    })
    return { store, scheduler, handlers: createHeartbeatHostHandlers({ heartbeats: scheduler }) }
  }

  function heartbeatOf(reply: RlmHostReplyData): HeartbeatWireRow | null {
    const result = okResult(reply)
    if (typeof result !== 'object' || result === null || Array.isArray(result)) throw new Error('expected an object result')
    return (result as { heartbeat: HeartbeatWireRow | null }).heartbeat
  }

  function heartbeatsOf(reply: RlmHostReplyData): HeartbeatWireRow[] {
    const result = okResult(reply)
    if (typeof result !== 'object' || result === null || Array.isArray(result)) throw new Error('expected an object result')
    return (result as { heartbeats: HeartbeatWireRow[] }).heartbeats
  }

  it('creates heartbeats with the wire reply shape and lists them per session', async () => {
    const { handlers } = rig()
    const created = heartbeatOf(await handlers['rlm_heartbeat.create']!(
      request({ type: 'rlm_heartbeat.create', instruction: 'check in', label: 'nightly' }),
      contextFor(agent('sess-1')),
    ))
    expect(created).not.toBeNull()
    const { id, ...createdRest } = created!
    expect(typeof id).toBe('string')
    expect(createdRest).toEqual({
      status: 'active',
      label: 'nightly',
      delivery_mode: 'steer',
      instruction: 'check in',
      schedule: { kind: 'interval', expression: 'every 5m', intervalMs: 300_000 },
      created_at: FIXED.toISOString(),
      updated_at: FIXED.toISOString(),
      next_run_at: '2031-03-04T05:11:07.000Z',
      last_run_at: null,
      last_error: null,
      run_count: 0,
    })
    await handlers['rlm_heartbeat.create']!(
      request({ type: 'rlm_heartbeat.create', instruction: 'other session' }),
      contextFor(agent('sess-2')),
    )
    const listed = heartbeatsOf(await handlers['rlm_heartbeat.list']!(
      request({ type: 'rlm_heartbeat.list' }), contextFor(agent('sess-1')),
    ))
    expect(listed).toHaveLength(1)
    expect(listed[0]?.instruction).toBe('check in')
  })

  it('honors interval, delivery_mode, and camelCase payload members', async () => {
    const { handlers } = rig()
    const snake = heartbeatOf(await handlers['rlm_heartbeat.create']!(
      request({ type: 'rlm_heartbeat.create', instruction: 'a', interval: '30s', delivery_mode: 'follow_up' }),
      contextFor(agent('sess-1')),
    ))
    expect(snake?.delivery_mode).toBe('follow_up')
    expect(snake?.schedule).toEqual({ kind: 'interval', expression: 'every 30s', intervalMs: 30_000 })
    const camel = heartbeatOf(await handlers['rlm_heartbeat.create']!(
      request({ type: 'rlm_heartbeat.create', instruction: 'b', deliveryMode: 'follow_up' }),
      contextFor(agent('sess-1')),
    ))
    expect(camel?.delivery_mode).toBe('follow_up')
    const cron = heartbeatOf(await handlers['rlm_heartbeat.create']!(
      request({ type: 'rlm_heartbeat.create', instruction: 'c', interval: '0 9 * * *' }),
      contextFor(agent('sess-1')),
    ))
    expect(cron?.schedule).toEqual({ kind: 'cron', expression: '0 9 * * *' })
    expect(cron?.next_run_at).not.toBeNull()
  })

  it('validates create payloads with the reference messages', async () => {
    const { handlers } = rig()
    const owner = contextFor(agent('sess-1'))
    await expect(call(handlers['rlm_heartbeat.create']!, request({ type: 'rlm_heartbeat.create' }), owner))
      .rejects.toThrow('rlm_heartbeat.create instruction must be a string')
    await expect(call(
      handlers['rlm_heartbeat.create']!,
      request({ type: 'rlm_heartbeat.create', instruction: 'a', interval: 30 }),
      owner,
    )).rejects.toThrow('rlm_heartbeat.create interval must be a string when provided')
    await expect(call(
      handlers['rlm_heartbeat.create']!,
      request({ type: 'rlm_heartbeat.create', instruction: 'a', label: 7 }),
      owner,
    )).rejects.toThrow('rlm_heartbeat.create label must be a string when provided')
    await expect(call(
      handlers['rlm_heartbeat.create']!,
      request({ type: 'rlm_heartbeat.create', instruction: 'a', delivery_mode: 'loud' }),
      owner,
    )).rejects.toThrow('Heartbeat delivery mode must be "steer" or "follow_up"')
    await expect(call(
      handlers['rlm_heartbeat.create']!,
      request({ type: 'rlm_heartbeat.create', instruction: '   ' }),
      owner,
    )).rejects.toThrow('RLM heartbeat instruction cannot be empty')
    await expect(call(
      handlers['rlm_heartbeat.create']!,
      request({ type: 'rlm_heartbeat.create', instruction: 'a', interval: 'in 10m' }),
      owner,
    )).rejects.toThrow('RLM heartbeat schedule must be recurring')
  })

  it('updates heartbeats and reports unknown or cancelled ids as null', async () => {
    const { handlers } = rig()
    const owner = contextFor(agent('sess-1'))
    const created = heartbeatOf(await handlers['rlm_heartbeat.create']!(
      request({ type: 'rlm_heartbeat.create', instruction: 'a' }), owner,
    ))
    const id = created!.id
    const paused = heartbeatOf(await handlers['rlm_heartbeat.update']!(
      request({ type: 'rlm_heartbeat.update', id, status: 'pause' }), owner,
    ))
    expect(paused?.status).toBe('paused')
    expect(paused?.next_run_at).toBeNull()
    const resumed = heartbeatOf(await handlers['rlm_heartbeat.update']!(
      request({
        type: 'rlm_heartbeat.update', id, status: 'resume', instruction: 'b', interval: '30s', label: 'nightly', deliveryMode: 'follow_up',
      }),
      owner,
    ))
    expect(resumed?.status).toBe('active')
    expect(resumed?.instruction).toBe('b')
    expect(resumed?.label).toBe('nightly')
    expect(resumed?.delivery_mode).toBe('follow_up')
    expect(resumed?.schedule).toEqual({ kind: 'interval', expression: 'every 30s', intervalMs: 30_000 })
    expect(resumed?.next_run_at).toBe('2031-03-04T05:06:37.000Z')
    expect(heartbeatOf(await handlers['rlm_heartbeat.update']!(
      request({ type: 'rlm_heartbeat.update', id: 'missing', label: 'x' }), owner,
    ))).toBeNull()
    await handlers['rlm_heartbeat.delete']!(request({ type: 'rlm_heartbeat.delete', id }), owner)
    expect(heartbeatOf(await handlers['rlm_heartbeat.update']!(
      request({ type: 'rlm_heartbeat.update', id, label: 'x' }), owner,
    ))).toBeNull()
  })

  it('validates update payloads with the reference messages', async () => {
    const { handlers } = rig()
    const owner = contextFor(agent('sess-1'))
    await expect(call(handlers['rlm_heartbeat.update']!, request({ type: 'rlm_heartbeat.update' }), owner))
      .rejects.toThrow('rlm_heartbeat.update id must be a string')
    await expect(call(
      handlers['rlm_heartbeat.update']!,
      request({ type: 'rlm_heartbeat.update', id: 'x', instruction: 5 }),
      owner,
    )).rejects.toThrow('rlm_heartbeat.update instruction must be a string when provided')
    await expect(call(
      handlers['rlm_heartbeat.update']!,
      request({ type: 'rlm_heartbeat.update', id: 'x', interval: 5 }),
      owner,
    )).rejects.toThrow('rlm_heartbeat.update interval must be a string when provided')
    await expect(call(
      handlers['rlm_heartbeat.update']!,
      request({ type: 'rlm_heartbeat.update', id: 'x', label: 5 }),
      owner,
    )).rejects.toThrow('rlm_heartbeat.update label must be a string when provided')
    await expect(call(
      handlers['rlm_heartbeat.update']!,
      request({ type: 'rlm_heartbeat.update', id: 'x', status: 'stop' }),
      owner,
    )).rejects.toThrow('rlm_heartbeat.update status must be "pause" or "resume" when provided')
    await expect(call(
      handlers['rlm_heartbeat.update']!,
      request({ type: 'rlm_heartbeat.update', id: 'x', status: null }),
      owner,
    )).rejects.toThrow('rlm_heartbeat.update status must be "pause" or "resume" when provided')
    await expect(call(
      handlers['rlm_heartbeat.update']!,
      request({ type: 'rlm_heartbeat.update', id: 'x', delivery_mode: 'loud' }),
      owner,
    )).rejects.toThrow('Heartbeat delivery mode must be "steer" or "follow_up"')
    await expect(call(
      handlers['rlm_heartbeat.update']!,
      request({ type: 'rlm_heartbeat.update', id: 'x' }),
      owner,
    )).rejects.toThrow('rlm_heartbeat.update requires at least one field to update')
  })

  it('deletes heartbeats and reports unknown ids as null', async () => {
    const { handlers } = rig()
    const owner = contextFor(agent('sess-1'))
    const created = heartbeatOf(await handlers['rlm_heartbeat.create']!(
      request({ type: 'rlm_heartbeat.create', instruction: 'a' }), owner,
    ))
    const deleted = heartbeatOf(await handlers['rlm_heartbeat.delete']!(
      request({ type: 'rlm_heartbeat.delete', id: created!.id }), owner,
    ))
    expect(deleted?.status).toBe('cancelled')
    expect(deleted?.next_run_at).toBeNull()
    expect(heartbeatOf(await handlers['rlm_heartbeat.delete']!(
      request({ type: 'rlm_heartbeat.delete', id: 'missing' }), owner,
    ))).toBeNull()
    const listed = heartbeatsOf(await handlers['rlm_heartbeat.list']!(
      request({ type: 'rlm_heartbeat.list' }), owner,
    ))
    expect(listed).toEqual([])
    const withInactive = heartbeatsOf(await handlers['rlm_heartbeat.list']!(
      request({ type: 'rlm_heartbeat.list', include_inactive: true }), owner,
    ))
    expect(withInactive).toHaveLength(1)
    const camelInactive = heartbeatsOf(await handlers['rlm_heartbeat.list']!(
      request({ type: 'rlm_heartbeat.list', includeInactive: true }), owner,
    ))
    expect(camelInactive).toHaveLength(1)
    await expect(call(
      handlers['rlm_heartbeat.delete']!,
      request({ type: 'rlm_heartbeat.delete' }),
      owner,
    )).rejects.toThrow('rlm_heartbeat.delete id must be a string')
  })

  it('surfaces recorded delivery failures in listed rows', async () => {
    const { store, handlers } = rig()
    const owner = contextFor(agent('gone'))
    const created = heartbeatOf(await handlers['rlm_heartbeat.create']!(
      request({ type: 'rlm_heartbeat.create', instruction: 'a', interval: '30s' }), owner,
    ))
    store.recordSkip(created!.id, 'RLM heartbeat target session "gone" is not live', FIXED)
    const listed = heartbeatsOf(await handlers['rlm_heartbeat.list']!(
      request({ type: 'rlm_heartbeat.list' }), owner,
    ))
    expect(listed[0]?.last_error).toBe('RLM heartbeat target session "gone" is not live')
  })
})
