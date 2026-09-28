import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { HarnessRefiner, HarnessStateError } from '@deepseek-ai/dsh-rlm-harness'
import type { HarnessEntryInput, HarnessRefinementProposal } from '@deepseek-ai/dsh-rlm-harness'
import { LocalHarnessRefiner } from '../src/index.ts'
import { globalHarnessStatePath, localHarnessStatePath } from '../src/index.ts'

const SESSION = SessionId('session-1')
const OTHER = SessionId('session-2')

function home(): string {
  return mkdtempSync(join(tmpdir(), 'rlm-harness-local-'))
}

function service(dir: string): LocalHarnessRefiner {
  return new LocalHarnessRefiner(new Context(), { dshHome: dir })
}

function entry(id: string, overrides: Partial<HarnessEntryInput> = {}): HarnessEntryInput {
  return { id, kind: 'memory', title: `Title ${id}`, content: `Body ${id}`, ...overrides }
}

function proposal(id: string, overrides: Partial<HarnessRefinementProposal> = {}): HarnessRefinementProposal {
  return { trigger: 'test pass', entries: [entry(id)], evidence: 'observed', outcome: 'refined', ...overrides }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('LocalHarnessRefiner', () => {
  it('registers itself as the rlmHarness service through the plugin contract', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalHarnessRefiner, { dshHome: home() })
    expect(ctx.get('rlmHarness')).toBeInstanceOf(LocalHarnessRefiner)
    await ctx.fiber.dispose()
  })

  it('satisfies the abstract seam type', () => {
    const refiner: HarnessRefiner = service(home())
    expect(refiner).toBeInstanceOf(HarnessRefiner)
  })

  it('resolves an empty or whitespace home override through the environment', async () => {
    const envHome = home()
    vi.stubEnv('DSH_HOME', envHome)
    for (const configured of ['', '   ']) {
      const refiner = new LocalHarnessRefiner(new Context(), { dshHome: configured })
      await refiner.writeEntry(entry('a'))
      expect(existsSync(globalHarnessStatePath(envHome))).toBe(true)
    }
  })

  it('resolves an omitted home override through the environment', async () => {
    const envHome = home()
    vi.stubEnv('DSH_HOME', envHome)
    const refiner = new LocalHarnessRefiner(new Context(), {})
    await refiner.writeEntry(entry('a'))
    expect(existsSync(globalHarnessStatePath(envHome))).toBe(true)
  })

  it('keeps session stores apart from each other and from the global store', async () => {
    const dir = home()
    const refiner = service(dir)
    await refiner.writeEntry(entry('mine'), { sessionId: SESSION })
    await refiner.writeEntry(entry('theirs'), { sessionId: OTHER })
    await refiner.writeEntry(entry('shared'))
    expect((await refiner.read({ sessionId: SESSION })).entries.memory['mine']?.title).toBe('Title mine')
    expect((await refiner.read({ sessionId: OTHER })).entries.memory['mine']).toBeUndefined()
    expect((await refiner.read()).entries.memory['mine']).toBeUndefined()
    expect(existsSync(localHarnessStatePath(dir, SESSION))).toBe(true)
    expect(existsSync(globalHarnessStatePath(dir))).toBe(true)
  })

  it('reads writes another process made after this service started', async () => {
    const dir = home()
    const refiner = service(dir)
    expect((await refiner.read()).refinements).toEqual([])
    const stale = new LocalHarnessRefiner(new Context(), { dshHome: dir })
    await stale.writeEntry(entry('outside'))
    expect((await refiner.read()).entries.memory['outside']?.title).toBe('Title outside')
  })

  it('rejects a session scope that is not a safe path segment', async () => {
    const refiner = service(home())
    await expect(refiner.read({ sessionId: SessionId('a/b') })).rejects.toThrow(HarnessStateError)
    await expect(refiner.writeEntry(entry('a'), { sessionId: SessionId('..') })).rejects.toThrow(HarnessStateError)
  })
})

describe('writeEntry', () => {
  it('normalizes, versions, and stamps the store scope on a fresh entry', async () => {
    const dir = home()
    const refiner = service(dir)
    const stored = await refiner.writeEntry(entry('a'), { sessionId: SESSION })
    expect(stored.version).toBe(1)
    expect(stored.scope).toBe('local')
    expect(stored.createdAt).toBe(stored.updatedAt)
    const globalStored = await refiner.writeEntry(entry('b'))
    expect(globalStored.scope).toBe('global')
  })

  it('keeps an explicit scope and bumps the version on an update', async () => {
    const refiner = service(home())
    const first = await refiner.writeEntry(entry('a', { scope: 'local' }))
    const second = await refiner.writeEntry(entry('a', { title: 'Renamed' }))
    expect(second.scope).toBe('local')
    expect(second.version).toBe(2)
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.title).toBe('Renamed')
  })

  it('rejects an unusable entry without writing anything', async () => {
    const dir = home()
    const refiner = service(dir)
    await expect(refiner.writeEntry(entry(' '))).rejects.toThrow(HarnessStateError)
    expect(existsSync(globalHarnessStatePath(dir))).toBe(false)
  })
})

describe('refine', () => {
  it('applies the proposal and records one event per pass', async () => {
    const refiner = service(home())
    const first = await refiner.refine(proposal('a'))
    expect(first).toMatchObject({ id: 'refine_0001', trigger: 'test pass', changes: ['a'], evidence: 'observed', outcome: 'refined' })
    const second = await refiner.refine(proposal('b'))
    expect(second.id).toBe('refine_0002')
    const state = await refiner.read()
    expect(state.refinements.map(event => event.id)).toEqual(['refine_0001', 'refine_0002'])
    expect(state.entries.memory['a']?.scope).toBe('global')
    expect(state.entries.memory['b']?.version).toBe(1)
  })

  it('mints a fresh identity when the sequence collides with the recorded history', async () => {
    const dir = home()
    mkdirSync(join(dir, 'rlm', 'harness'), { recursive: true })
    writeFileSync(globalHarnessStatePath(dir), JSON.stringify({
      schema: 1,
      entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
      refinements: [
        { id: 'refine_0001', trigger: 't', changes: [], evidence: '', outcome: '', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'refine_0003', trigger: 't', changes: [], evidence: '', outcome: '', createdAt: '2026-01-01T00:00:00.000Z' },
      ],
    }), { flag: 'w' })
    const refiner = service(dir)
    const event = await refiner.refine(proposal('a'))
    expect(event.id).toBe('refine_0004')
  })

  it('applies the whole proposal or none of it', async () => {
    const dir = home()
    const refiner = service(dir)
    await refiner.writeEntry(entry('kept'))
    const before = readFileSync(globalHarnessStatePath(dir), 'utf8')
    await expect(refiner.refine(proposal('new', { entries: [entry('new'), entry('bad', { title: ' ' })] }))).rejects.toThrow(HarnessStateError)
    expect(readFileSync(globalHarnessStatePath(dir), 'utf8')).toBe(before)
    expect((await refiner.read()).entries.memory['new']).toBeUndefined()
    expect((await refiner.read()).refinements).toEqual([])
  })
})

describe('rollback', () => {
  it('drops every refinement after the named one and leaves the entries', async () => {
    const refiner = service(home())
    const first = await refiner.refine(proposal('a'))
    await refiner.refine(proposal('b'))
    const removed = await refiner.rollback(first.id)
    expect(removed).toBe(1)
    const state = await refiner.read()
    expect(state.refinements.map(event => event.id)).toEqual([first.id])
    expect(state.entries.memory['b']?.title).toBe('Title b')
  })

  it('reports zero and writes nothing for an unknown event', async () => {
    const dir = home()
    const refiner = service(dir)
    await refiner.refine(proposal('a'))
    const before = readFileSync(globalHarnessStatePath(dir), 'utf8')
    expect(await refiner.rollback('refine_9999')).toBe(0)
    expect(readFileSync(globalHarnessStatePath(dir), 'utf8')).toBe(before)
  })

  it('reports zero against an empty store without creating it', async () => {
    const dir = home()
    const refiner = service(dir)
    expect(await refiner.rollback('refine_0001')).toBe(0)
    expect(existsSync(globalHarnessStatePath(dir))).toBe(false)
  })

  it('reports zero when the named event is already the newest', async () => {
    const refiner = service(home())
    const only = await refiner.refine(proposal('a'))
    expect(await refiner.rollback(only.id)).toBe(0)
    expect((await refiner.read()).refinements).toHaveLength(1)
  })
})

describe('list', () => {
  it('returns every kind in insertion order when no kind is named', async () => {
    const refiner = service(home())
    await refiner.writeEntry(entry('m1'))
    await refiner.writeEntry(entry('p1', { kind: 'prompt' }))
    await refiner.writeEntry(entry('m2'))
    const all = await refiner.list()
    expect(all.map(stored => stored.id)).toEqual(['p1', 'm1', 'm2'])
  })

  it('returns one kind when named', async () => {
    const refiner = service(home())
    await refiner.writeEntry(entry('m1'))
    await refiner.writeEntry(entry('p1', { kind: 'prompt' }))
    expect((await refiner.list('prompt')).map(stored => stored.id)).toEqual(['p1'])
    expect(await refiner.list('skill')).toEqual([])
  })
})
