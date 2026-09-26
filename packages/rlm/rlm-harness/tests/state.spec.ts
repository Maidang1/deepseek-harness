import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  applyRefinement,
  DEFAULT_HARNESS_PATH,
  DEFAULT_HARNESS_SOURCE,
  emptyHarnessState,
  entryJson,
  HARNESS_KINDS,
  HarnessStateError,
  normalizeEntry,
  rollbackToEvent,
  withEntry,
} from '../src/index.ts'
import type { HarnessEntryInput, HarnessRefinementProposal, HarnessState } from '../src/index.ts'
import { HarnessRefiner } from '../src/index.ts'

const NOW = '2026-09-26T00:00:00Z'

function entry(id: string, overrides: Partial<HarnessEntryInput> = {}): HarnessEntryInput {
  return { id, kind: 'memory', title: `Title ${id}`, content: `Body ${id}`, ...overrides }
}

describe('emptyHarnessState', () => {
  it('starts with every kind present and empty', () => {
    const state = emptyHarnessState()
    expect(Object.keys(state.entries)).toEqual([...HARNESS_KINDS])
    expect(state.entries.prompt).toEqual({})
    expect(state.refinements).toEqual([])
  })
})

describe('normalizeEntry', () => {
  it('fills defaults for a new record', () => {
    const normalized = normalizeEntry(entry('a'), undefined, NOW)
    expect(normalized).toEqual({
      id: 'a',
      kind: 'memory',
      title: 'Title a',
      content: 'Body a',
      path: DEFAULT_HARNESS_PATH,
      scope: 'local',
      reference: {},
      arguments: {},
      metadata: {},
      source: DEFAULT_HARNESS_SOURCE,
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
    })
  })

  it('carries prior fields and bumps the revision on an update', () => {
    const first = normalizeEntry(entry('a'), undefined, NOW)
    const second = normalizeEntry(entry('a', { title: 'Renamed' }), first, '2026-09-27T00:00:00Z')
    expect(second.title).toBe('Renamed')
    expect(second.createdAt).toBe(NOW)
    expect(second.updatedAt).toBe('2026-09-27T00:00:00Z')
    expect(second.version).toBe(2)
  })

  it('honors explicit scope, path, and authorship', () => {
    const normalized = normalizeEntry(entry('a', { scope: 'global', path: 'ops', source: 'human' }), undefined, NOW)
    expect(normalized.scope).toBe('global')
    expect(normalized.path).toBe('ops')
    expect(normalized.source).toBe('human')
  })

  it('rejects an unusable record', () => {
    expect(() => normalizeEntry(entry(' '), undefined, NOW)).toThrow(HarnessStateError)
    expect(() => normalizeEntry(entry('a', { title: '  ' }), undefined, NOW)).toThrow(HarnessStateError)
    expect(() => normalizeEntry(entry('a', { content: '' }), undefined, NOW)).toThrow(HarnessStateError)
    expect(() => normalizeEntry(entry('a', { kind: 'skill' }), undefined, NOW)).toThrow(HarnessStateError)
  })

  it('accepts a skill carrying a Python reference', () => {
    const reference = { type: 'python', import: 'ops' }
    expect(normalizeEntry(entry('a', { kind: 'skill', reference }), undefined, NOW).reference).toEqual(reference)
  })
})

describe('withEntry', () => {
  it('stores under the entry kind without touching the input', () => {
    const state = emptyHarnessState()
    const stored = normalizeEntry(entry('a'), undefined, NOW)
    const next = withEntry(state, stored)
    expect(next.entries.memory.a).toBe(stored)
    expect(state.entries.memory).toEqual({})
    expect(next.refinements).toBe(state.refinements)
  })
})

describe('applyRefinement', () => {
  it('applies every write and records one event', () => {
    const state = applyRefinement(emptyHarnessState(), {
      trigger: 'session/end',
      entries: [entry('a'), entry('b', { kind: 'prompt' })],
      evidence: 'saw two gaps',
      outcome: 'wrote two entries',
    }, NOW, 'ref-1')
    expect(Object.keys(state.entries.memory)).toEqual(['a'])
    expect(Object.keys(state.entries.prompt)).toEqual(['b'])
    expect(state.refinements).toEqual([{
      id: 'ref-1',
      trigger: 'session/end',
      changes: ['a', 'b'],
      evidence: 'saw two gaps',
      outcome: 'wrote two entries',
      createdAt: NOW,
    }])
  })

  it('updates an existing entry in place', () => {
    const first = applyRefinement(emptyHarnessState(), {
      trigger: 't', entries: [entry('a')], evidence: '', outcome: '',
    }, NOW, 'ref-1')
    const second = applyRefinement(first, {
      trigger: 't', entries: [entry('a', { content: 'Second' })], evidence: '', outcome: '',
    }, '2026-09-27T00:00:00Z', 'ref-2')
    expect(second.entries.memory.a?.content).toBe('Second')
    expect(second.entries.memory.a?.version).toBe(2)
    expect(second.refinements).toHaveLength(2)
  })
})

describe('rollbackToEvent', () => {
  it('truncates history after the named event', () => {
    const first = applyRefinement(emptyHarnessState(), {
      trigger: 't', entries: [entry('a')], evidence: '', outcome: '',
    }, NOW, 'ref-1')
    const second = applyRefinement(first, {
      trigger: 't', entries: [entry('b')], evidence: '', outcome: '',
    }, NOW, 'ref-2')
    const rolled = rollbackToEvent(second, 'ref-1')
    expect(rolled.refinements.map(event => event.id)).toEqual(['ref-1'])
    expect(Object.keys(rolled.entries.memory)).toEqual(['a', 'b'])
  })

  it('returns the state unchanged for an unknown event', () => {
    const state = emptyHarnessState()
    expect(rollbackToEvent(state, 'nope')).toBe(state)
  })
})

describe('entryJson', () => {
  it('projects every stored field', () => {
    const stored = normalizeEntry(entry('a'), undefined, NOW)
    expect(entryJson(stored)).toEqual({
      id: 'a',
      kind: 'memory',
      title: 'Title a',
      content: 'Body a',
      path: 'general',
      scope: 'local',
      reference: {},
      arguments: {},
      metadata: {},
      source: 'agent',
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
    })
  })
})

describe('HarnessRefiner', () => {
  it('registers a provider under the seam key', async () => {
    class StubRefiner extends HarnessRefiner {
      read = (): Promise<HarnessState> => Promise.resolve(emptyHarnessState())
      refine = (_proposal: HarnessRefinementProposal) => Promise.resolve({ id: 'r', trigger: '', changes: [], evidence: '', outcome: '', createdAt: NOW })
      rollback = (_eventId: string) => Promise.resolve(0)
      writeEntry = (input: HarnessEntryInput) => Promise.resolve(normalizeEntry(input, undefined, NOW))
      list = () => Promise.resolve([])
    }
    const provider = new StubRefiner(new Context())
    await expect(provider.list()).resolves.toEqual([])
    await expect(provider.refine({ trigger: 't', entries: [], evidence: '', outcome: '' }))
      .resolves.toMatchObject({ id: 'r' })
    await expect(provider.rollback('none')).resolves.toBe(0)
  })
})
