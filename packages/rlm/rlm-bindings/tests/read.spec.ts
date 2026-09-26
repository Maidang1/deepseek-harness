import { describe, expect, it } from 'vitest'
import {
  bashCompletionField,
  bashConsumedField,
  collectTargetsField,
  collectTimeoutField,
  compactRlmText,
  createDefaultChildName,
  deleteTargetField,
  findModelsRequest,
  isRecord,
  kwargsField,
  MAX_RLM_MODEL_SEARCH_LIMIT,
  normalizeRequestedModel,
  normalizeRequestedName,
  normalizeRequestedThinking,
  ok,
  progressNoteMessage,
  RLM_PROGRESS_NOTE_MAX_LENGTH,
  RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH,
  rlmChildLabel,
  splitModelSelector,
  stringField,
} from '../src/read.ts'

describe('ok', () => {
  it('wraps a result as a success reply', () => {
    expect(ok({ a: 1 })).toEqual({ status: 'ok', result: { a: 1 } })
  })
})

describe('isRecord', () => {
  it('accepts only plain objects', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord(null)).toBe(false)
    expect(isRecord([])).toBe(false)
    expect(isRecord('x')).toBe(false)
  })
})

describe('stringField', () => {
  it('reads a string member and rejects anything else', () => {
    expect(stringField({ prompt: 'go' }, 'prompt', 'bad')).toBe('go')
    expect(() => stringField({ prompt: 1 }, 'prompt', 'bad')).toThrow('bad')
    expect(() => stringField({}, 'prompt', 'bad')).toThrow('bad')
  })
})

describe('kwargsField', () => {
  it('returns the record, tolerating a missing or malformed member', () => {
    expect(kwargsField({ kwargs: { name: 'n' } })).toEqual({ name: 'n' })
    expect(kwargsField({})).toEqual({})
    expect(kwargsField({ kwargs: [1] })).toEqual({})
  })
})

describe('normalizeRequestedName', () => {
  it('passes undefined through', () => {
    expect(normalizeRequestedName(undefined, 'rlm.spawn')).toBeUndefined()
  })

  it('rejects a non-string name', () => {
    expect(() => normalizeRequestedName(1, 'rlm.spawn')).toThrow('rlm.spawn name must be a string')
  })

  it('rejects an empty name', () => {
    expect(() => normalizeRequestedName('   ', 'rlm.spawn')).toThrow('rlm.spawn name must not be empty')
  })

  it('rejects an over-length name and trims a valid one', () => {
    const long = 'x'.repeat(RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH + 1)
    expect(() => normalizeRequestedName(long, 'rlm.spawn'))
      .toThrow(`rlm.spawn name must be at most ${RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH} characters`)
    expect(normalizeRequestedName(` ${'x'.repeat(RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH)} `, 'rlm.spawn'))
      .toBe('x'.repeat(RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH))
  })
})

describe('normalizeRequestedModel', () => {
  it('validates the selector shape only', () => {
    expect(normalizeRequestedModel(undefined, 'rlm.spawn')).toBeUndefined()
    expect(() => normalizeRequestedModel(1, 'rlm.spawn')).toThrow('rlm.spawn model must be a string')
    expect(() => normalizeRequestedModel('  ', 'rlm.spawn')).toThrow('rlm.spawn model must not be empty')
    expect(normalizeRequestedModel(' p/m ', 'rlm.spawn')).toBe('p/m')
  })
})

describe('normalizeRequestedThinking', () => {
  it('validates the effort shape only', () => {
    expect(normalizeRequestedThinking(undefined, 'rlm.spawn')).toBeUndefined()
    expect(() => normalizeRequestedThinking(1, 'rlm.spawn')).toThrow('rlm.spawn thinking must be a string')
    expect(() => normalizeRequestedThinking('  ', 'rlm.spawn')).toThrow('rlm.spawn thinking must not be empty')
    expect(normalizeRequestedThinking(' high ', 'rlm.spawn')).toBe('high')
  })
})

describe('splitModelSelector', () => {
  it('splits on the first slash', () => {
    expect(splitModelSelector('p/m/x', 'rlm.spawn')).toEqual({ provider: 'p', model: 'm/x' })
  })

  it('rejects a selector without a usable split', () => {
    expect(() => splitModelSelector('plain', 'rlm.spawn')).toThrow('rlm.spawn model must use the form "provider/model-id"')
    expect(() => splitModelSelector('/model', 'rlm.spawn')).toThrow('rlm.spawn model must use the form "provider/model-id"')
    expect(() => splitModelSelector('provider/', 'rlm.spawn')).toThrow('rlm.spawn model must use the form "provider/model-id"')
  })
})

describe('createDefaultChildName', () => {
  it('builds a slugged name from the prompt and id', () => {
    expect(createDefaultChildName('Fix the flaky Test!', 'abcd1234-efgh'))
      .toBe('subagent-fix-the-flaky-test-1234efgh')
  })

  it('falls back to worker for an unusable prompt', () => {
    expect(createDefaultChildName('', 'abcd1234')).toBe('subagent-worker-abcd1234')
    expect(createDefaultChildName('!!!', 'abcd1234')).toBe('subagent-worker-abcd1234')
  })

  it('falls back to child for an id without alphanumerics', () => {
    expect(createDefaultChildName('task', '----')).toBe('subagent-task-child')
  })

  it('truncates a long prompt to the name budget', () => {
    const name = createDefaultChildName('word '.repeat(40), 'abcd1234')
    expect(name.length).toBeLessThanOrEqual(RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH)
    expect(name.endsWith('-abcd1234')).toBe(true)
    expect(name.includes('--')).toBe(false)
  })
})

describe('compactRlmText', () => {
  it('collapses whitespace and caps at the default length', () => {
    expect(compactRlmText('  a\n b\t c ')).toBe('a b c')
    const long = 'x'.repeat(200)
    expect(compactRlmText(long)).toBe(`${'x'.repeat(157)}...`)
  })

  it('honors an explicit cap', () => {
    expect(compactRlmText('abcdefgh', 5)).toBe('ab...')
    expect(compactRlmText('abc', 3)).toBe('abc')
  })
})

describe('rlmChildLabel', () => {
  it('collapses the prompt to one line, with a fallback', () => {
    expect(rlmChildLabel('a\n b')).toBe('a b')
    expect(rlmChildLabel('   ')).toBe('child agent')
  })
})

describe('findModelsRequest', () => {
  it('defaults the limit and validates its range', () => {
    expect(findModelsRequest({ query: 'q' })).toEqual({ query: 'q', limit: 8 })
    expect(findModelsRequest({ query: '', limit: MAX_RLM_MODEL_SEARCH_LIMIT }))
      .toEqual({ query: '', limit: MAX_RLM_MODEL_SEARCH_LIMIT })
    expect(() => findModelsRequest({ limit: 1 })).toThrow('rlm.find_models query must be a string')
    expect(() => findModelsRequest({ query: 'q', limit: 'x' }))
      .toThrow(`rlm.find_models limit must be an integer from 1 to ${MAX_RLM_MODEL_SEARCH_LIMIT}`)
    expect(() => findModelsRequest({ query: 'q', limit: 1.5 }))
      .toThrow(`rlm.find_models limit must be an integer from 1 to ${MAX_RLM_MODEL_SEARCH_LIMIT}`)
    expect(() => findModelsRequest({ query: 'q', limit: 0 }))
      .toThrow(`rlm.find_models limit must be an integer from 1 to ${MAX_RLM_MODEL_SEARCH_LIMIT}`)
    expect(() => findModelsRequest({ query: 'q', limit: MAX_RLM_MODEL_SEARCH_LIMIT + 1 }))
      .toThrow(`rlm.find_models limit must be an integer from 1 to ${MAX_RLM_MODEL_SEARCH_LIMIT}`)
  })
})

describe('collectTargetsField', () => {
  it('treats an absent or null member as every child', () => {
    expect(collectTargetsField({})).toEqual([])
    expect(collectTargetsField({ targets: null })).toEqual([])
  })

  it('rejects a non-array member', () => {
    expect(() => collectTargetsField({ targets: 'x' }))
      .toThrow('rlm.collect targets must be an array of child ids or names')
  })

  it('rejects non-string and empty members, trimming valid ones', () => {
    expect(() => collectTargetsField({ targets: [1] })).toThrow('rlm.collect targets must be non-empty strings')
    expect(() => collectTargetsField({ targets: ['  '] })).toThrow('rlm.collect targets must be non-empty strings')
    expect(collectTargetsField({ targets: [' a ', 'b'] })).toEqual(['a', 'b'])
  })
})

describe('collectTimeoutField', () => {
  it('defaults to zero and validates the range', () => {
    expect(collectTimeoutField({})).toBe(0)
    expect(collectTimeoutField({ timeout_ms: null })).toBe(0)
    expect(collectTimeoutField({ timeout_ms: 2_147_483_647 })).toBe(2_147_483_647)
    expect(() => collectTimeoutField({ timeout_ms: '1' }))
      .toThrow('rlm.collect timeout_ms must be a non-negative integer up to 2147483647')
    expect(() => collectTimeoutField({ timeout_ms: 1.5 }))
      .toThrow('rlm.collect timeout_ms must be a non-negative integer up to 2147483647')
    expect(() => collectTimeoutField({ timeout_ms: -1 }))
      .toThrow('rlm.collect timeout_ms must be a non-negative integer up to 2147483647')
    expect(() => collectTimeoutField({ timeout_ms: 2_147_483_648 }))
      .toThrow('rlm.collect timeout_ms must be a non-negative integer up to 2147483647')
  })
})

describe('progressNoteMessage', () => {
  it('validates and trims the message', () => {
    expect(progressNoteMessage({ message: ' hi ' })).toBe('hi')
    expect(progressNoteMessage({ message: 'x'.repeat(RLM_PROGRESS_NOTE_MAX_LENGTH) })).toHaveLength(RLM_PROGRESS_NOTE_MAX_LENGTH)
    expect(() => progressNoteMessage({})).toThrow('rlm.progress.note message must be a non-empty string')
    expect(() => progressNoteMessage({ message: '  ' })).toThrow('rlm.progress.note message must be a non-empty string')
    expect(() => progressNoteMessage({ message: 'x'.repeat(RLM_PROGRESS_NOTE_MAX_LENGTH + 1) }))
      .toThrow(`rlm.progress.note message must be at most ${RLM_PROGRESS_NOTE_MAX_LENGTH} characters`)
  })
})

describe('deleteTargetField', () => {
  it('validates and trims the target', () => {
    expect(deleteTargetField({ target: ' t ' })).toBe('t')
    expect(() => deleteTargetField({})).toThrow('rlm.delete_subagent target must be a non-empty string')
    expect(() => deleteTargetField({ target: 1 })).toThrow('rlm.delete_subagent target must be a non-empty string')
    expect(() => deleteTargetField({ target: ' ' })).toThrow('rlm.delete_subagent target must be a non-empty string')
  })
})

describe('bashCompletionField', () => {
  it('validates every member', () => {
    expect(bashCompletionField({ pid: 3, command: 'ls', exitCode: 0 })).toEqual({ pid: 3, command: 'ls', exitCode: 0 })
    expect(() => bashCompletionField({ pid: '3', command: 'ls', exitCode: 0 }))
      .toThrow('bash.completed pid must be a positive integer')
    expect(() => bashCompletionField({ pid: 1.5, command: 'ls', exitCode: 0 }))
      .toThrow('bash.completed pid must be a positive integer')
    expect(() => bashCompletionField({ pid: 0, command: 'ls', exitCode: 0 }))
      .toThrow('bash.completed pid must be a positive integer')
    expect(() => bashCompletionField({ pid: 3, command: 1, exitCode: 0 }))
      .toThrow('bash.completed command must be a non-empty string')
    expect(() => bashCompletionField({ pid: 3, command: '', exitCode: 0 }))
      .toThrow('bash.completed command must be a non-empty string')
    expect(() => bashCompletionField({ pid: 3, command: 'ls', exitCode: '0' }))
      .toThrow('bash.completed exitCode must be an integer')
    expect(() => bashCompletionField({ pid: 3, command: 'ls', exitCode: 0.5 }))
      .toThrow('bash.completed exitCode must be an integer')
  })
})

describe('bashConsumedField', () => {
  it('validates every member', () => {
    expect(bashConsumedField({ pid: 3, command: 'ls' })).toEqual({ pid: 3, command: 'ls' })
    expect(() => bashConsumedField({ pid: '3', command: 'ls' })).toThrow('bash.consumed pid must be a positive integer')
    expect(() => bashConsumedField({ pid: 1.5, command: 'ls' })).toThrow('bash.consumed pid must be a positive integer')
    expect(() => bashConsumedField({ pid: -1, command: 'ls' })).toThrow('bash.consumed pid must be a positive integer')
    expect(() => bashConsumedField({ pid: 3, command: 1 })).toThrow('bash.consumed command must be a non-empty string')
    expect(() => bashConsumedField({ pid: 3, command: '' })).toThrow('bash.consumed command must be a non-empty string')
  })
})
