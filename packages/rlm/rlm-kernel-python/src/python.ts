/**
 * Interpreter resolution for the CPython kernel provider. Misconfiguration
 * fails at load: a configured interpreter that is not a usable CPython of the
 * supported range is an error the operator fixes once, not a per-cell surprise.
 *
 * @module @deepseek-ai/dsh-rlm-kernel-python/python
 */

import { execFileSync } from 'node:child_process'
import { RLM_MINIMUM_PYTHON_MAJOR, RLM_MINIMUM_PYTHON_MINOR, RlmKernelError } from '@deepseek-ai/dsh-rlm-kernel'

/** Probe deadline in milliseconds; a hung interpreter must not block load. */
export const PYTHON_PROBE_TIMEOUT_MS = 5_000

/** One release triple reported by an interpreter. */
export interface PythonRelease {
  readonly major: number
  readonly minor: number
  readonly micro: string
}

/** One resolved interpreter. */
export interface PythonInterpreter {
  /** The command the child is spawned with, exactly as configured. */
  readonly bin: string
  /** The interpreter's own version string, as reported by `platform.python_version()`. */
  readonly version: string
}

/**
 * Parse `platform.python_version()` output.
 *
 * @param output - the interpreter's printed version string.
 * @returns the parsed release triple, or `undefined` when the text is not one.
 */
export function parsePythonVersion(output: string): PythonRelease | undefined {
  const { major, minor, micro } = /^(?<major>\d+)\.(?<minor>\d+)\.(?<micro>\d+)$/u
    .exec(output.trim())?.groups ?? {}
  if (major === undefined || minor === undefined || micro === undefined) return undefined
  return { major: Number(major), minor: Number(minor), micro }
}

/**
 * Whether one release is inside the range the kernel runtime supports.
 *
 * @param release - the parsed release triple.
 * @returns whether the interpreter is new enough to run the kernel.
 */
export function isSupportedPython(release: PythonRelease): boolean {
  if (release.major !== RLM_MINIMUM_PYTHON_MAJOR) return release.major > RLM_MINIMUM_PYTHON_MAJOR
  return release.minor >= RLM_MINIMUM_PYTHON_MINOR
}

/**
 * Resolve the configured interpreter and check it is a supported CPython.
 *
 * @param configured - an absolute executable path or a bare command resolved through `PATH`.
 * @returns the resolved interpreter.
 * @throws {RlmKernelError} when the command cannot run or is not a supported CPython.
 */
export function resolvePythonInterpreter(configured: string): PythonInterpreter {
  let output: string
  try {
    output = execFileSync(configured, ['-c', 'import platform; print(platform.python_version())'], {
      encoding: 'utf8',
      timeout: PYTHON_PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch (error: unknown) {
    throw new RlmKernelError(`rlm-kernel-python: cannot run interpreter "${configured}"`, { cause: error })
  }
  const release = parsePythonVersion(output)
  if (release === undefined) {
    throw new RlmKernelError(`rlm-kernel-python: interpreter "${configured}" did not report a version`)
  }
  if (!isSupportedPython(release)) {
    throw new RlmKernelError(
      `rlm-kernel-python: interpreter "${configured}" is ${release.major}.${release.minor}, `
      + `but the kernel needs ${RLM_MINIMUM_PYTHON_MAJOR}.${RLM_MINIMUM_PYTHON_MINOR} or newer`,
    )
  }
  return { bin: configured, version: output.trim() }
}
