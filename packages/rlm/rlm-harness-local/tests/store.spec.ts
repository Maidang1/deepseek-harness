import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HARNESS_PATH,
  DEFAULT_HARNESS_SOURCE,
  HARNESS_KINDS,
  HarnessStateError,
} from '@deepseek-ai/dsh-rlm-harness'
import {
  globalHarnessStatePath,
  HARNESS_STATE_DIR_NAME,
  HARNESS_STATE_FILE_MODE,
  HARNESS_STATE_FILE_NAME,
  HARNESS_STATE_SCHEMA,
  harnessStatePath,
  harnessStoreScope,
  loadHarnessState,
  localHarnessStatePath,
  parseHarnessState,
  RLM_DIR_NAME,
  saveHarnessState,
  serializeHarnessState,
} from '../src/store.ts'
import type { HarnessEntry } from '@deepseek-ai/dsh-rlm-harness'
import { SessionId } from '@deepseek-ai/dsh-session'

const NOW = '2026-09-27T00:00:00.000Z'
const SESSION = SessionId('session-1')

function home(): string {
  return mkdtempSync(join(tmpdir(), 'rlm-harness-store-'))
}

describe('path helpers', () => {
  it('composes the global store path under the RLM root of the home', () => {
    expect(globalHarnessStatePath('/home')).toBe(join('/home', RLM_DIR_NAME, HARNESS_STATE_DIR_NAME, HARNESS_STATE_FILE_NAME))
  })

  it('composes a session store path one directory deeper', () => {
    expect(localHarnessStatePath('/home', SESSION)).toBe(join('/home', RLM_DIR_NAME, HARNESS_STATE_DIR_NAME, 'sessions', SESSION, HARNESS_STATE_FILE_NAME))
  })

  it('rejects a session id that is not a safe path segment', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b']) {
      expect(() => localHarnessStatePath('/home', bad)).toThrow(HarnessStateError)
    }
  })

  it('routes an omitted or empty scope to the global store and a session scope to its own', () => {
    expect(harnessStatePath('/home')).toBe(globalHarnessStatePath('/home'))
    expect(harnessStatePath('/home', {})).toBe(globalHarnessStatePath('/home'))
    expect(harnessStatePath('/home', { sessionId: SESSION })).toBe(localHarnessStatePath('/home', SESSION))
  })

  it('derives the store scope the same way it routes', () => {
    expect(harnessStoreScope()).toBe('global')
    expect(harnessStoreScope({})).toBe('global')
    expect(harnessStoreScope({ sessionId: SESSION })).toBe('local')
  })
})

describe('parseHarnessState', () => {
  it('reads a corrupt document as the empty state', () => {
    const state = parseHarnessState('{not json', 'local', NOW)
    for (const kind of HARNESS_KINDS) expect(state.entries[kind]).toEqual({})
    expect(state.refinements).toEqual([])
  })

  it.each(['null', '[1, 2]', '"text"', '42'])('reads the non-object document %s as the empty state', (text) => {
    const state = parseHarnessState(text, 'local', NOW)
    expect(state.refinements).toEqual([])
    expect(Object.keys(state.entries.memory)).toEqual([])
  })

  it('ignores a non-object entries document and a non-object kind bucket', () => {
    const text = JSON.stringify({ entries: { memory: 5, prompt: [{ id: 'a' }] } })
    const state = parseHarnessState(text, 'local', NOW)
    expect(state.entries.memory).toEqual({})
    expect(state.entries.prompt).toEqual({})
  })

  it('ignores a missing entries document entirely', () => {
    const state = parseHarnessState('{}', 'local', NOW)
    for (const kind of HARNESS_KINDS) expect(state.entries[kind]).toEqual({})
  })

  it('skips records that are not objects or carry no usable title or content', () => {
    const text = JSON.stringify({
      entries: {
        memory: {
          stray: 7,
          untitled: { content: 'body' },
          bodiless: { title: 'title' },
        },
      },
    })
    expect(parseHarnessState(text, 'local', NOW).entries.memory).toEqual({})
  })

  it('normalizes a fully stored entry and keeps every explicit field', () => {
    const stored: HarnessEntry = {
      id: 'a',
      kind: 'skill',
      title: 'Title',
      content: 'Body',
      path: 'ops',
      scope: 'global',
      reference: { type: 'python', import: 'ops' },
      arguments: { flag: true },
      metadata: { note: 'n' },
      source: 'human',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      version: 3,
    }
    const text = JSON.stringify({ entries: { skill: { a: stored } } })
    const [entry] = Object.values(parseHarnessState(text, 'local', NOW).entries.skill)
    expect(entry).toEqual(stored)
  })

  it('migrates a topic-spelled grouping and defaults a missing one', () => {
    const text = JSON.stringify({
      entries: {
        memory: {
          legacy: { title: 't', content: 'c', topic: 'ops' },
          plain: { title: 't', content: 'c' },
        },
      },
    })
    const entries = parseHarnessState(text, 'local', NOW).entries.memory
    expect(entries['legacy']?.path).toBe('ops')
    expect(entries['plain']?.path).toBe(DEFAULT_HARNESS_PATH)
  })

  it('falls back to the store scope when the stored scope is unusable', () => {
    const text = JSON.stringify({
      entries: {
        memory: {
          local: { title: 't', content: 'c', scope: 'local' },
          global: { title: 't', content: 'c', scope: 'global' },
          weird: { title: 't', content: 'c', scope: 'elsewhere' },
          missing: { title: 't', content: 'c' },
        },
      },
    })
    const entries = parseHarnessState(text, 'global', NOW).entries.memory
    expect(entries['local']?.scope).toBe('local')
    expect(entries['global']?.scope).toBe('global')
    expect(entries['weird']?.scope).toBe('global')
    expect(entries['missing']?.scope).toBe('global')
  })

  it('defaults malformed record fields and stamps missing timestamps with the load clock', () => {
    const text = JSON.stringify({
      entries: {
        memory: {
          a: { title: 't', content: 'c', reference: 5, arguments: null, metadata: [1], source: 9 },
        },
      },
    })
    const entry = parseHarnessState(text, 'local', NOW).entries.memory['a']
    expect(entry?.reference).toEqual({})
    expect(entry?.arguments).toEqual({})
    expect(entry?.metadata).toEqual({})
    expect(entry?.source).toBe(DEFAULT_HARNESS_SOURCE)
    expect(entry?.createdAt).toBe(NOW)
    expect(entry?.updatedAt).toBe(NOW)
  })

  it('coerces an unusable version to one', () => {
    const text = JSON.stringify({
      entries: {
        memory: {
          valid: { title: 't', content: 'c', version: 4 },
          text: { title: 't', content: 'c', version: '4' },
          fraction: { title: 't', content: 'c', version: 1.5 },
          zero: { title: 't', content: 'c', version: 0 },
          missing: { title: 't', content: 'c' },
        },
      },
    })
    const entries = parseHarnessState(text, 'local', NOW).entries.memory
    expect(entries['valid']?.version).toBe(4)
    expect(entries['text']?.version).toBe(1)
    expect(entries['fraction']?.version).toBe(1)
    expect(entries['zero']?.version).toBe(1)
    expect(entries['missing']?.version).toBe(1)
  })

  it('ignores a non-list refinement history', () => {
    const text = JSON.stringify({ refinements: 'refine_0001' })
    expect(parseHarnessState(text, 'local', NOW).refinements).toEqual([])
  })

  it('skips events without a usable identity, trigger, or change list', () => {
    const text = JSON.stringify({
      refinements: [
        7,
        { trigger: 't', changes: [] },
        { id: 'e', changes: [] },
        { id: 'e', trigger: 't' },
        { id: 'e', trigger: 't', changes: 9 },
      ],
    })
    expect(parseHarnessState(text, 'local', NOW).refinements).toEqual([])
  })

  it('normalizes stored events, wrapping a single change and filtering a mixed list', () => {
    const text = JSON.stringify({
      refinements: [
        { id: 'e1', trigger: 't', changes: 'a', evidence: 'seen', outcome: 'done', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'e2', trigger: 't', changes: ['a', 7, 'b'] },
      ],
    })
    const [first, second] = parseHarnessState(text, 'local', NOW).refinements
    expect(first).toEqual({ id: 'e1', trigger: 't', changes: ['a'], evidence: 'seen', outcome: 'done', createdAt: '2026-01-01T00:00:00.000Z' })
    expect(second).toEqual({ id: 'e2', trigger: 't', changes: ['a', 'b'], evidence: '', outcome: '', createdAt: NOW })
  })
})

describe('loadHarnessState', () => {
  it('reads a missing file as the empty state', async () => {
    const state = await loadHarnessState(join(home(), 'absent', HARNESS_STATE_FILE_NAME), 'local', NOW)
    expect(state.refinements).toEqual([])
    expect(state.entries.memory).toEqual({})
  })

  it('parses the file on disk', async () => {
    const dir = home()
    const filePath = join(dir, HARNESS_STATE_FILE_NAME)
    writeFileSync(filePath, JSON.stringify({ entries: { memory: { a: { title: 't', content: 'c' } } }, refinements: [] }))
    const state = await loadHarnessState(filePath, 'local', NOW)
    expect(state.entries.memory['a']?.title).toBe('t')
  })
})

describe('serializeHarnessState and saveHarnessState', () => {
  it('round-trips a state through the file, recording the schema version', async () => {
    const dir = home()
    const filePath = join(dir, 'nested', HARNESS_STATE_FILE_NAME)
    const written = parseHarnessState(JSON.stringify({
      entries: { memory: { a: { title: 't', content: 'c', createdAt: NOW, updatedAt: NOW } } },
      refinements: [{ id: 'refine_0001', trigger: 'manual', changes: ['a'], evidence: '', outcome: '', createdAt: NOW }],
    }), 'local', NOW)
    await saveHarnessState(filePath, written)
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toMatchObject({ schema: HARNESS_STATE_SCHEMA })
    expect(await loadHarnessState(filePath, 'local', NOW)).toEqual(written)
  })

  it('creates a fresh file owner-only and keeps an existing file\'s mode', async () => {
    const dir = home()
    const filePath = join(dir, HARNESS_STATE_FILE_NAME)
    const state = parseHarnessState('{}', 'local', NOW)
    await saveHarnessState(filePath, state)
    expect(statSync(filePath).mode & 0o777).toBe(HARNESS_STATE_FILE_MODE)
    chmodSync(filePath, 0o640)
    await saveHarnessState(filePath, state)
    expect(statSync(filePath).mode & 0o777).toBe(0o640)
  })

  it('serializes with a trailing newline', () => {
    expect(serializeHarnessState(parseHarnessState('{}', 'local', NOW)).endsWith('\n')).toBe(true)
  })
})
