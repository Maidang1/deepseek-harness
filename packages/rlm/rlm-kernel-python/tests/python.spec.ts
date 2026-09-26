import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RlmKernelError } from '@deepseek-ai/dsh-rlm-kernel'
import {
  isSupportedPython,
  parsePythonVersion,
  PYTHON_PROBE_TIMEOUT_MS,
  resolvePythonInterpreter,
} from '../src/python.ts'

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, execFileSync: execFileSyncMock }
})

// Probe the real interpreter unless a stubbed test replaced it.
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  execFileSyncMock.mockImplementation(actual.execFileSync)
})

describe('parsePythonVersion', () => {
  it('reads a release triple', () => {
    expect(parsePythonVersion('3.13.11')).toEqual({ major: 3, minor: 13, micro: '11' })
    expect(parsePythonVersion('  3.10.0\n')).toEqual({ major: 3, minor: 10, micro: '0' })
  })

  it('rejects anything else', () => {
    expect(parsePythonVersion('3.13')).toBeUndefined()
    expect(parsePythonVersion('three')).toBeUndefined()
    expect(parsePythonVersion('')).toBeUndefined()
  })
})

describe('isSupportedPython', () => {
  it('admits the supported range', () => {
    expect(isSupportedPython({ major: 3, minor: 10, micro: '0' })).toBe(true)
    expect(isSupportedPython({ major: 3, minor: 14, micro: '6' })).toBe(true)
    expect(isSupportedPython({ major: 4, minor: 0, micro: '0' })).toBe(true)
  })

  it('rejects an older interpreter', () => {
    expect(isSupportedPython({ major: 3, minor: 9, micro: '21' })).toBe(false)
    expect(isSupportedPython({ major: 2, minor: 7, micro: '18' })).toBe(false)
  })
})

describe('resolvePythonInterpreter', () => {
  it('resolves a real interpreter', () => {
    const interpreter = resolvePythonInterpreter('python3')
    expect(parsePythonVersion(interpreter.version)).toBeDefined()
    expect(interpreter.bin).toBe('python3')
  })

  it('fails loud on a command that cannot run', () => {
    expect(() => resolvePythonInterpreter('/definitely/not/a/python')).toThrow(RlmKernelError)
  })

  it('pins the probe deadline', () => {
    expect(PYTHON_PROBE_TIMEOUT_MS).toBe(5_000)
  })
})

describe('resolvePythonInterpreter over a stubbed probe', () => {
  it('rejects an interpreter that does not report a version', () => {
    execFileSyncMock.mockReturnValue('CPython 3.14\n')
    expect(() => resolvePythonInterpreter('python3')).toThrow('did not report a version')
  })

  it('rejects an interpreter older than the supported range', () => {
    execFileSyncMock.mockReturnValue('3.9.21\n')
    expect(() => resolvePythonInterpreter('python3')).toThrow('is 3.9, but the kernel needs 3.10 or newer')
  })

  it('rejects a major release outside the supported range', () => {
    execFileSyncMock.mockReturnValue('2.7.18\n')
    expect(() => resolvePythonInterpreter('python3')).toThrow('is 2.7, but the kernel needs 3.10 or newer')
  })
})
