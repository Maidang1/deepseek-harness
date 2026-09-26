import { describe, expect, it } from 'vitest'
import { RLM_PROGRESS_NOTE_MIN_INTERVAL_MS, RLM_PROGRESS_NOTE_RING_MAX, Roster } from '../src/roster.ts'

function admission(childId: string, name: string) {
  return { childId, name, model: 'p/m', label: `label ${name}`, createdAt: 1 }
}

describe('reserve', () => {
  it('rejects a name an admitted sibling already holds', () => {
    const roster = new Roster()
    roster.admit('p', admission('c1', 'alpha'))
    expect(() => roster.reserve('p', 'alpha', 'rlm.spawn'))
      .toThrow('rlm.spawn name "alpha" is already used by a sibling in the current parent session')
  })

  it('rejects a name another in-flight spawn reserved, until released', () => {
    const roster = new Roster()
    const release = roster.reserve('p', 'alpha', 'rlm.spawn')
    expect(() => roster.reserve('p', 'alpha', 'rlm.spawn')).toThrow('already used by a sibling')
    release()
    release()
    expect(() => roster.reserve('p', 'alpha', 'rlm.spawn')).not.toThrow()
  })

  it('scopes names to their parent', () => {
    const roster = new Roster()
    roster.admit('p1', admission('c1', 'alpha'))
    expect(() => roster.reserve('p2', 'alpha', 'rlm.spawn')).not.toThrow()
  })
})

describe('admit', () => {
  it('binds the child id to the name and clears the reservation', () => {
    const roster = new Roster()
    roster.reserve('p', 'alpha', 'rlm.spawn')
    roster.admit('p', admission('c1', 'alpha'))
    expect(roster.entry('p', 'c1')).toMatchObject({ name: 'alpha', model: 'p/m' })
    expect(() => roster.reserve('p', 'alpha', 'rlm.spawn')).toThrow('already used by a sibling')
  })

  it('admits without a prior reservation, and admits a second child to the same parent', () => {
    const roster = new Roster()
    roster.admit('p', admission('c1', 'alpha'))
    roster.admit('p', admission('c2', 'beta'))
    expect(roster.entry('p', 'c1')?.name).toBe('alpha')
    expect(roster.entry('p', 'c2')?.name).toBe('beta')
  })
})

describe('forget', () => {
  it('drops the child and frees its name', () => {
    const roster = new Roster()
    roster.admit('p', admission('c1', 'alpha'))
    roster.forget('p', 'c1')
    expect(roster.entry('p', 'c1')).toBeUndefined()
    expect(roster.progressNote('c1')).toBeUndefined()
    expect(() => roster.reserve('p', 'alpha', 'rlm.spawn')).not.toThrow()
  })

  it('tolerates an unknown parent or child', () => {
    const roster = new Roster()
    roster.admit('p', admission('c1', 'alpha'))
    expect(() => { roster.forget('other', 'c1') }).not.toThrow()
    expect(() => { roster.forget('p', 'unknown') }).not.toThrow()
    expect(roster.entry('p', 'c1')).toBeDefined()
  })
})

describe('entry', () => {
  it('misses unknown parents and children', () => {
    const roster = new Roster()
    roster.admit('p', admission('c1', 'alpha'))
    expect(roster.entry('other', 'c1')).toBeUndefined()
    expect(roster.entry('p', 'other')).toBeUndefined()
  })
})

describe('progress notes', () => {
  it('accepts the first note and throttles the next inside the interval', () => {
    const roster = new Roster()
    roster.admit('p', admission('c1', 'alpha'))
    expect(roster.noteProgress('c1', 'one', 1000)).toEqual({ accepted: true })
    expect(roster.noteProgress('c1', 'two', 2000)).toEqual({
      accepted: false,
      retryAfterMs: RLM_PROGRESS_NOTE_MIN_INTERVAL_MS - 1000,
    })
    expect(roster.progressNote('c1')).toBe('one')
  })

  it('accepts again after the interval and keeps a bounded ring', () => {
    const roster = new Roster()
    roster.admit('p', admission('c1', 'alpha'))
    for (let index = 0; index < RLM_PROGRESS_NOTE_RING_MAX + 2; index += 1) {
      expect(roster.noteProgress('c1', `note ${index}`, index * RLM_PROGRESS_NOTE_MIN_INTERVAL_MS)).toEqual({ accepted: true })
    }
    expect(roster.entry('p', 'c1')?.notes).toHaveLength(RLM_PROGRESS_NOTE_RING_MAX)
    expect(roster.progressNote('c1')).toBe(`note ${RLM_PROGRESS_NOTE_RING_MAX + 1}`)
  })

  it('returns undefined for a session that is no RLM child', () => {
    const roster = new Roster()
    expect(roster.noteProgress('nobody', 'hi', 0)).toBeUndefined()
    expect(roster.progressNote('nobody')).toBeUndefined()
  })
})

describe('activity stamps', () => {
  it('stamps a new event time once and keeps the first stamp while the cut is unchanged', () => {
    const roster = new Roster()
    roster.admit('p', admission('c1', 'alpha'))
    roster.observeActivity('c1', 500, 10)
    roster.observeActivity('c1', 500, 20)
    expect(roster.activityMonotonicAt('c1')).toBe(10)
    roster.observeActivity('c1', 600, 30)
    expect(roster.activityMonotonicAt('c1')).toBe(30)
  })

  it('ignores an unknown child', () => {
    const roster = new Roster()
    roster.observeActivity('nobody', 500, 10)
    expect(roster.activityMonotonicAt('nobody')).toBeUndefined()
  })
})
