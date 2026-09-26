/**
 * Wire constants and inbound validation for the persistent Python REPL
 * protocol. The child process is a foreign subprocess that can send anything,
 * so every frame is rebuilt field by field before a consumer reads it.
 *
 * @module @deepseek-ai/dsh-rlm-kernel/protocol
 */

import { isJsonValue } from '@deepseek-ai/dsh-util-values'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  RlmDoneEvent,
  RlmDisplayEvent,
  RlmErrorEvent,
  RlmHostRequestEvent,
  RlmOutputEvent,
  RlmReadyEvent,
  RlmResultEvent,
  RlmWireEvent,
} from './types.ts'

/** Protocol version this host speaks; the child announces the same value in `ready`. */
export const RLM_PROTOCOL_VERSION = 3

/** Python versions the kernel providers support. */
export const RLM_MINIMUM_PYTHON_MAJOR = 3
/** Lowest supported Python minor version, against {@link RLM_MINIMUM_PYTHON_MAJOR}. */
export const RLM_MINIMUM_PYTHON_MINOR = 10

/** One JSON object per line; no other framing exists on the wire. */
export const RLM_FRAME_SEPARATOR = '\n'

/**
 * Rebuild one parsed line as a validated event.
 *
 * A forged frame never rides along: every field is read through its own type
 * check, and any line that fails one returns `undefined` so the caller drops
 * it instead of acting on attacker-chosen content.
 *
 * @param line - one non-empty line of the child's stdout.
 * @returns the rebuilt event, or `undefined` when the line is not a valid event.
 */
export function parseRlmEvent(line: string): RlmWireEvent | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  return rebuildEvent(parsed)
}

/**
 * Rebuild one already-parsed frame as a validated event.
 *
 * @param frame - the parsed JSON value of one wire line.
 * @returns the rebuilt event, or `undefined` when the frame is not a valid event.
 */
export function rebuildEvent(frame: unknown): RlmWireEvent | undefined {
  if (typeof frame !== 'object' || frame === null) return undefined
  const tag = (frame as { event?: unknown }).event
  switch (tag) {
    case 'ready':
      return rebuildReady(frame)
    case 'stdout':
    case 'stderr':
      return rebuildOutput(frame, tag)
    case 'result':
      return rebuildResult(frame)
    case 'display':
      return rebuildDisplay(frame)
    case 'host_request':
      return rebuildHostRequest(frame)
    case 'error':
      return rebuildError(frame)
    case 'done':
      return rebuildDone(frame)
    default:
      return undefined
  }
}

/**
 * Encode one request as the child expects to read it.
 *
 * @param request - the request to serialize.
 * @returns the request as one JSON line, terminated by the frame separator.
 */
export function encodeRlmRequest(request: object): string {
  return `${JSON.stringify(request)}${RLM_FRAME_SEPARATOR}`
}

/**
 * Narrow one parsed wire field to a JSON object whose members are JSON values.
 *
 * @param value - the parsed field, whose member types are unverified.
 * @returns the object when every member survives a lossless JSON check, otherwise `undefined`.
 */
function jsonObject(value: unknown): Record<string, JsonValue> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  if (!isJsonValue(value)) return undefined
  return value as Record<string, JsonValue>
}

/**
 * Narrow one parsed wire field to a string array.
 *
 * @param value - the parsed field, whose element types are unverified.
 * @returns the elements when every one is a string, otherwise `undefined`.
 */
function stringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const names: string[] = []
  for (const name of value) {
    if (typeof name !== 'string') return undefined
    names.push(name)
  }
  return names
}

function rebuildReady(frame: unknown): RlmReadyEvent | undefined {
  const { protocol, python } = frame as { protocol?: unknown; python?: unknown }
  if (typeof protocol !== 'number' || typeof python !== 'string') return undefined
  return { event: 'ready', protocol, python }
}

function rebuildOutput(frame: unknown, event: 'stdout' | 'stderr'): RlmOutputEvent | undefined {
  const { id, text } = frame as { id?: unknown; text?: unknown }
  if (typeof text !== 'string') return undefined
  const cellId = id === null ? null : typeof id === 'string' ? id : undefined
  if (cellId === undefined) return undefined
  return { event, id: cellId, text }
}

function rebuildResult(frame: unknown): RlmResultEvent | undefined {
  const { id, text } = frame as { id?: unknown; text?: unknown }
  if (typeof id !== 'string' || typeof text !== 'string') return undefined
  return { event: 'result', id, text }
}

function rebuildDisplay(frame: unknown): RlmDisplayEvent | undefined {
  const { id, data } = frame as { id?: unknown; data?: unknown }
  const payload = jsonObject(data)
  if (payload === undefined) return undefined
  const cellId = id === null ? null : typeof id === 'string' ? id : undefined
  if (cellId === undefined) return undefined
  return { event: 'display', id: cellId, data: payload }
}

function rebuildHostRequest(frame: unknown): RlmHostRequestEvent | undefined {
  const { id, data } = frame as { id?: unknown; data?: unknown }
  if (typeof id !== 'string') return undefined
  const payload = jsonObject(data)
  if (payload === undefined) return undefined
  return { event: 'host_request', id, data: payload }
}

function rebuildError(frame: unknown): RlmErrorEvent | undefined {
  const { id, ename, evalue, traceback } = frame as {
    id?: unknown
    ename?: unknown
    evalue?: unknown
    traceback?: unknown
  }
  if (typeof ename !== 'string' || typeof evalue !== 'string') return undefined
  const frames = stringList(traceback)
  if (frames === undefined) return undefined
  const cellId = id === null ? null : typeof id === 'string' ? id : undefined
  if (cellId === undefined) return undefined
  return { event: 'error', id: cellId, ename, evalue, traceback: frames }
}

function rebuildDone(frame: unknown): RlmDoneEvent | undefined {
  const source = frame as { id?: unknown; status?: unknown; reason?: unknown; bytes?: unknown }
  const { id, status, reason, bytes } = source
  if (typeof id !== 'string') return undefined
  if (status !== 'ok' && status !== 'error') return undefined
  const done: {
    event: 'done'
    id: string
    status: 'ok' | 'error'
    reason?: string
    saved?: readonly string[]
    skipped?: readonly string[]
    pruned?: readonly string[]
    bytes?: number
    restored?: readonly string[]
    failed?: readonly string[]
    names?: readonly string[]
  } = { event: 'done', id, status }
  if (typeof reason === 'string') done.reason = reason
  for (const key of ['saved', 'skipped', 'pruned', 'restored', 'failed', 'names'] as const) {
    const names = stringList((frame as Record<string, unknown>)[key])
    if (names !== undefined) done[key] = names
  }
  if (typeof bytes === 'number') done.bytes = bytes
  return done
}
