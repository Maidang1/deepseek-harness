/**
 * Wire-payload readers, reply constructors, and request normalizers for the
 * RLM host bindings. A reader throws an `Error` whose message matches the
 * reference host implementation, because the kernel turns a thrown handler
 * into the error reply the model reads verbatim.
 *
 * @module @deepseek-ai/dsh-rlm-bindings/read
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { RlmHostReplyOk } from '@deepseek-ai/dsh-rlm-kernel'

/** Hard cap for a requested child session name, in UTF-16 code units. */
export const RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH = 64

/** Default number of model matches one `rlm.find_models` call returns. */
export const DEFAULT_RLM_MODEL_SEARCH_LIMIT = 8

/** Largest `limit` one `rlm.find_models` call accepts. */
export const MAX_RLM_MODEL_SEARCH_LIMIT = 20

/** Hard cap for one child progress note, in UTF-16 code units. */
export const RLM_PROGRESS_NOTE_MAX_LENGTH = 512

/** Largest `timeout_ms` one `rlm.collect` call accepts. */
const MAX_COLLECT_TIMEOUT_MS = 2_147_483_647

/**
 * Wrap one handler result as the success reply the runtime unwraps.
 *
 * @param result - the reply payload the requesting cell receives.
 * @returns the `ok` reply frame for the kernel.
 */
export function ok(result: JsonValue): RlmHostReplyOk {
  return { status: 'ok', result }
}

/**
 * True for a plain object payload member, never for an array or `null`.
 *
 * @param value - the payload member under test.
 * @returns whether the member is a string-keyed record.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one required string member of a request payload.
 *
 * @param data - the `host_request` payload.
 * @param key - the member to read.
 * @param message - the error message a non-string member raises.
 * @returns the member's string value.
 */
export function stringField(data: Readonly<Record<string, unknown>>, key: string, message: string): string {
  const value = data[key]
  if (typeof value !== 'string') throw new Error(message)
  return value
}

/**
 * Read the `kwargs` member of a spawn-style payload, tolerating a missing or
 * malformed member as no kwargs at all.
 *
 * @param data - the `host_request` payload.
 * @returns the kwargs record, or an empty one.
 */
export function kwargsField(data: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const value = data['kwargs']
  return isRecord(value) ? value : {}
}

/**
 * Normalize a requested child session name, or `undefined` when omitted.
 *
 * @param value - the raw `name` kwarg.
 * @param operation - the wire type the error messages name.
 * @returns the trimmed name.
 */
export function normalizeRequestedName(value: unknown, operation: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${operation} name must be a string`)
  const name = value.trim()
  if (name.length === 0) throw new Error(`${operation} name must not be empty`)
  if (name.length > RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH) {
    throw new Error(`${operation} name must be at most ${RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH} characters`)
  }
  return name
}

/**
 * Normalize a requested `provider/model` selector, or `undefined` when omitted.
 *
 * @param value - the raw `model` kwarg.
 * @param operation - the wire type the error messages name.
 * @returns the trimmed selector.
 */
export function normalizeRequestedModel(value: unknown, operation: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${operation} model must be a string`)
  const model = value.trim()
  if (model.length === 0) throw new Error(`${operation} model must not be empty`)
  return model
}

/**
 * Normalize a requested reasoning effort, or `undefined` when omitted. The
 * effort vocabulary is adapter-owned, so the bindings check only the shape.
 *
 * @param value - the raw `thinking` kwarg.
 * @param operation - the wire type the error messages name.
 * @returns the trimmed effort id.
 */
export function normalizeRequestedThinking(value: unknown, operation: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${operation} thinking must be a string`)
  const thinking = value.trim()
  if (thinking.length === 0) throw new Error(`${operation} thinking must not be empty`)
  return thinking
}

/**
 * Split a normalized `provider/model` selector into its route parts.
 *
 * @param selector - the normalized selector.
 * @param operation - the wire type the error message names.
 * @returns the provider route and the model id.
 */
export function splitModelSelector(selector: string, operation: string): { provider: string; model: string } {
  const slash = selector.indexOf('/')
  if (slash <= 0 || slash === selector.length - 1) {
    throw new Error(`${operation} model must use the form "provider/model-id"`)
  }
  return { provider: selector.slice(0, slash), model: selector.slice(slash + 1) }
}

/**
 * Create a readable, collision-resistant default child name from the initial
 * prompt and the minted child id.
 *
 * @param prompt - the child's initial prompt.
 * @param childId - the minted child session id.
 * @returns a name unique enough to select the child by.
 */
export function createDefaultChildName(prompt: string, childId: string): string {
  const promptSlug = prompt
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const idSuffix = childId.replace(/[^A-Za-z0-9]+/g, '').slice(-8) || 'child'
  const fixedLength = 'subagent--'.length + idSuffix.length
  const promptPart = (promptSlug || 'worker')
    .slice(0, Math.max(1, RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH - fixedLength))
    .replace(/-+$/g, '')
  return `subagent-${promptPart}-${idSuffix}`
}

/**
 * Collapse one text to a single line capped at `maxLength` characters, for
 * answer previews and labels carried into roster rows.
 *
 * @param text - the source text.
 * @param maxLength - the cap, in UTF-16 code units.
 * @returns the compacted text, ellipsized when capped.
 */
export function compactRlmText(text: string, maxLength = 160): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length <= maxLength) return compact
  return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
}

/**
 * Collapse a child's initial prompt to its one-line roster label, keeping the
 * full length so a client can elide shared prefixes itself.
 *
 * @param prompt - the child's initial prompt.
 * @returns the one-line label.
 */
export function rlmChildLabel(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim() || 'child agent'
}

/** Validated `rlm.find_models` arguments. */
export interface FindModelsRequest {
  /** Search text matched against selector, id, and name. */
  readonly query: string
  /** Maximum number of matches returned. */
  readonly limit: number
}

/**
 * Read the arguments of one `rlm.find_models` payload.
 *
 * @param data - the `host_request` payload.
 * @returns the validated query and limit.
 */
export function findModelsRequest(data: Readonly<Record<string, unknown>>): FindModelsRequest {
  const query = stringField(data, 'query', 'rlm.find_models query must be a string')
  const raw = data['limit']
  const limit = raw === undefined ? DEFAULT_RLM_MODEL_SEARCH_LIMIT : raw
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_RLM_MODEL_SEARCH_LIMIT) {
    throw new Error(`rlm.find_models limit must be an integer from 1 to ${MAX_RLM_MODEL_SEARCH_LIMIT}`)
  }
  return { query, limit }
}

/**
 * Read and normalize the `targets` member of one `rlm.collect` payload.
 *
 * @param data - the `host_request` payload.
 * @returns the trimmed target selectors, empty when omitted.
 */
export function collectTargetsField(data: Readonly<Record<string, unknown>>): string[] {
  const raw = data['targets']
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    throw new Error('rlm.collect targets must be an array of child ids or names')
  }
  const list: readonly unknown[] = raw
  return list.map((target) => {
    if (typeof target !== 'string' || target.trim().length === 0) {
      throw new Error('rlm.collect targets must be non-empty strings')
    }
    return target.trim()
  })
}

/**
 * Read the `timeout_ms` member of one `rlm.collect` payload.
 *
 * @param data - the `host_request` payload.
 * @returns the bounded wait in milliseconds, `0` when omitted.
 */
export function collectTimeoutField(data: Readonly<Record<string, unknown>>): number {
  const raw = data['timeout_ms']
  if (raw === undefined || raw === null) return 0
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0 || raw > MAX_COLLECT_TIMEOUT_MS) {
    throw new Error(`rlm.collect timeout_ms must be a non-negative integer up to ${MAX_COLLECT_TIMEOUT_MS}`)
  }
  return raw
}

/**
 * Read and normalize the `message` member of one `rlm.progress.note` payload.
 *
 * @param data - the `host_request` payload.
 * @returns the trimmed progress note.
 */
export function progressNoteMessage(data: Readonly<Record<string, unknown>>): string {
  const raw = data['message']
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('rlm.progress.note message must be a non-empty string')
  }
  const message = raw.trim()
  if (message.length > RLM_PROGRESS_NOTE_MAX_LENGTH) {
    throw new Error(`rlm.progress.note message must be at most ${RLM_PROGRESS_NOTE_MAX_LENGTH} characters`)
  }
  return message
}

/**
 * Read and normalize the `target` member of one `rlm.delete_subagent` payload.
 *
 * @param data - the `host_request` payload.
 * @returns the trimmed target selector.
 */
export function deleteTargetField(data: Readonly<Record<string, unknown>>): string {
  const raw = data['target']
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('rlm.delete_subagent target must be a non-empty string')
  }
  return raw.trim()
}

/** Validated `bash.completed` notification. */
export interface BashCompletion {
  /** Process id of the finished command. */
  readonly pid: number
  /** The command line that finished. */
  readonly command: string
  /** The process exit code. */
  readonly exitCode: number
}

/**
 * Read one `bash.completed` notification payload.
 *
 * @param data - the `host_request` payload.
 * @returns the validated completion.
 */
export function bashCompletionField(data: Readonly<Record<string, unknown>>): BashCompletion {
  const pid = data['pid']
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    throw new Error('bash.completed pid must be a positive integer')
  }
  const command = data['command']
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error('bash.completed command must be a non-empty string')
  }
  const exitCode = data['exitCode']
  if (typeof exitCode !== 'number' || !Number.isInteger(exitCode)) {
    throw new Error('bash.completed exitCode must be an integer')
  }
  return { pid, command, exitCode }
}

/**
 * Read one `bash.consumed` notification payload.
 *
 * @param data - the `host_request` payload.
 * @returns the validated pid and command.
 */
export function bashConsumedField(data: Readonly<Record<string, unknown>>): { pid: number; command: string } {
  const pid = data['pid']
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    throw new Error('bash.consumed pid must be a positive integer')
  }
  const command = data['command']
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error('bash.consumed command must be a non-empty string')
  }
  return { pid, command }
}
