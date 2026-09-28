/**
 * JSON file persistence for the Local harness refiner: one
 * `harness_state.json` per scope under the RLM root of the DSH home. The
 * on-disk shape mirrors the reference host's — a `schema` version, entries
 * grouped by kind and then by id, and the refinement history in application
 * order — so a state file remains readable by hand and replayable by tooling.
 * Loading is total: a missing, unreadable, or corrupt file reads as the empty
 * state, and every stored record is revalidated field by field, because the
 * file is shared with writers outside this process and must never crash a
 * session that only reads it.
 *
 * @module @deepseek-ai/dsh-rlm-harness-local/store
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  DEFAULT_HARNESS_PATH,
  DEFAULT_HARNESS_SOURCE,
  emptyHarnessState,
  HARNESS_KINDS,
  HarnessStateError,
} from '@deepseek-ai/dsh-rlm-harness'
import type {
  HarnessEntry,
  HarnessKind,
  HarnessScope,
  HarnessScopeRef,
  HarnessState,
  RefinementEvent,
} from '@deepseek-ai/dsh-rlm-harness'

/** Directory under the DSH home that groups every RLM-owned file. */
export const RLM_DIR_NAME = 'rlm'

/** Directory under the RLM root that holds the harness stores. */
export const HARNESS_STATE_DIR_NAME = 'harness'

/** File name of one scope's harness store. */
export const HARNESS_STATE_FILE_NAME = 'harness_state.json'

/** On-disk schema version written with every save. */
export const HARNESS_STATE_SCHEMA = 1

/** Permission bits stamped on a freshly created state file. */
export const HARNESS_STATE_FILE_MODE = 0o600

/** Permission bits stamped on directories a save creates. */
export const HARNESS_STATE_DIR_MODE = 0o700

/**
 * A JSON object as the state file stores one. `JSON.parse` produces only
 * JSON values, so once a value is known to be a plain object its members are
 * JSON values by construction.
 */
type JsonRecord = HarnessEntry['reference']

/** Re-interpret a parsed JSON value as a record, or decline every other shape. */
function jsonRecord(value: JsonValue | undefined): JsonRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value
}

/**
 * Absolute path of the machine-wide harness store under one DSH home.
 *
 * @param home - resolved DSH home directory.
 * @returns the global store's state file path.
 */
export function globalHarnessStatePath(home: string): string {
  return join(home, RLM_DIR_NAME, HARNESS_STATE_DIR_NAME, HARNESS_STATE_FILE_NAME)
}

/**
 * Absolute path of one session's harness store under one DSH home.
 *
 * @param home - resolved DSH home directory.
 * @param sessionId - session the store belongs to; must be a single safe path segment.
 * @returns the session store's state file path.
 * @throws {HarnessStateError} when the id could escape the sessions directory.
 */
export function localHarnessStatePath(home: string, sessionId: string): string {
  if (sessionId === '' || sessionId === '.' || sessionId === '..' || sessionId.includes('/') || sessionId.includes('\\')) {
    throw new HarnessStateError(`harness session id ${JSON.stringify(sessionId)} is not a safe path segment`)
  }
  return join(home, RLM_DIR_NAME, HARNESS_STATE_DIR_NAME, 'sessions', sessionId, HARNESS_STATE_FILE_NAME)
}

/**
 * Absolute path of the store one scope reference addresses.
 *
 * @param home - resolved DSH home directory.
 * @param scope - the session the state belongs to, or the global store when omitted.
 * @returns the addressed store's state file path.
 */
export function harnessStatePath(home: string, scope?: HarnessScopeRef): string {
  return scope?.sessionId === undefined ? globalHarnessStatePath(home) : localHarnessStatePath(home, scope.sessionId)
}

/**
 * The scope a store file holds, derived the same way {@link harnessStatePath} routes.
 *
 * @param scope - the scope reference a call addressed.
 * @returns `local` for a session store, `global` for the machine-wide store.
 */
export function harnessStoreScope(scope?: HarnessScopeRef): HarnessScope {
  return scope?.sessionId === undefined ? 'global' : 'local'
}

/**
 * Revalidate one stored entry, migrating the shapes earlier writers used.
 *
 * @param id - identity the entry was filed under.
 * @param kind - kind bucket the entry was filed under; wins over the record.
 * @param raw - the parsed record.
 * @param scope - scope of the store being loaded, the fallback authorship scope.
 * @param now - the caller's clock reading, stamping records that carry no timestamps.
 * @returns the normalized entry, or `undefined` when the record is unusable.
 */
function loadEntry(id: string, kind: HarnessKind, raw: JsonValue | undefined, scope: HarnessScope, now: string): HarnessEntry | undefined {
  const record = jsonRecord(raw)
  if (record === undefined) return undefined
  const title = record['title']
  const content = record['content']
  if (typeof title !== 'string' || typeof content !== 'string') return undefined
  const storedPath = record['path']
  // State written while the grouping was named `topic` carries no `path`;
  // migrate it on load so the grouping survives the next save.
  const storedTopic = record['topic']
  const storedScope = record['scope']
  const storedSource = record['source']
  const storedCreatedAt = record['createdAt']
  const storedUpdatedAt = record['updatedAt']
  const storedVersion = record['version']
  return {
    id,
    kind,
    title,
    content,
    path: typeof storedPath === 'string' ? storedPath : typeof storedTopic === 'string' ? storedTopic : DEFAULT_HARNESS_PATH,
    scope: storedScope === 'local' || storedScope === 'global' ? storedScope : scope,
    reference: jsonRecord(record['reference']) ?? {},
    arguments: jsonRecord(record['arguments']) ?? {},
    metadata: jsonRecord(record['metadata']) ?? {},
    source: typeof storedSource === 'string' ? storedSource : DEFAULT_HARNESS_SOURCE,
    createdAt: typeof storedCreatedAt === 'string' ? storedCreatedAt : now,
    updatedAt: typeof storedUpdatedAt === 'string' ? storedUpdatedAt : now,
    version: typeof storedVersion === 'number' && Number.isInteger(storedVersion) && storedVersion >= 1 ? storedVersion : 1,
  }
}

/**
 * Revalidate one stored refinement event.
 *
 * @param raw - the parsed record.
 * @param now - the caller's clock reading, stamping events that carry no timestamp.
 * @returns the normalized event, or `undefined` when the record is unusable.
 */
function loadRefinement(raw: JsonValue, now: string): RefinementEvent | undefined {
  const record = jsonRecord(raw)
  if (record === undefined) return undefined
  const id = record['id']
  const trigger = record['trigger']
  if (typeof id !== 'string' || typeof trigger !== 'string') return undefined
  const storedChanges = record['changes']
  let changes: readonly string[]
  if (typeof storedChanges === 'string') {
    changes = [storedChanges]
  } else if (Array.isArray(storedChanges)) {
    changes = storedChanges.filter((change): change is string => typeof change === 'string')
  } else {
    return undefined
  }
  const evidence = record['evidence']
  const outcome = record['outcome']
  const createdAt = record['createdAt']
  return {
    id,
    trigger,
    changes,
    evidence: typeof evidence === 'string' ? evidence : '',
    outcome: typeof outcome === 'string' ? outcome : '',
    createdAt: typeof createdAt === 'string' ? createdAt : now,
  }
}

/**
 * Parse one state file's text into a harness state.
 *
 * @param text - the file's raw content.
 * @param scope - scope of the store being loaded, the fallback entry scope.
 * @param now - the caller's clock reading for records without timestamps.
 * @returns the parsed state; any unparseable or non-object document reads as empty.
 */
export function parseHarnessState(text: string, scope: HarnessScope, now: string): HarnessState {
  let document: JsonValue
  try {
    document = JSON.parse(text) as JsonValue
  } catch {
    // A torn or corrupt file must not crash the reader; the next save rewrites it cleanly.
    return emptyHarnessState()
  }
  const root = jsonRecord(document)
  if (root === undefined) return emptyHarnessState()
  const entries = {} as Record<HarnessKind, Record<string, HarnessEntry>>
  for (const kind of HARNESS_KINDS) entries[kind] = {}
  const refinements: RefinementEvent[] = []
  const storedEntries = jsonRecord(root['entries'])
  if (storedEntries !== undefined) {
    for (const kind of HARNESS_KINDS) {
      const bucket = jsonRecord(storedEntries[kind])
      if (bucket === undefined) continue
      for (const [id, raw] of Object.entries(bucket)) {
        const entry = loadEntry(id, kind, raw, scope, now)
        if (entry === undefined) continue
        entries[kind][entry.id] = entry
      }
    }
  }
  const storedRefinements = root['refinements']
  if (Array.isArray(storedRefinements)) {
    for (const raw of storedRefinements) {
      const event = loadRefinement(raw, now)
      if (event === undefined) continue
      refinements.push(event)
    }
  }
  return { entries, refinements }
}

/**
 * Read one store's current state from disk, including writes another process
 * made since this service started.
 *
 * @param filePath - the store's state file path.
 * @param scope - scope of the store being loaded, the fallback entry scope.
 * @param now - the caller's clock reading for records without timestamps.
 * @returns the stored state; a missing or unreadable file reads as empty.
 */
export async function loadHarnessState(filePath: string, scope: HarnessScope, now: string): Promise<HarnessState> {
  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch {
    return emptyHarnessState()
  }
  return parseHarnessState(text, scope, now)
}

/**
 * The JSON one save writes for a state.
 *
 * @param state - the state to persist.
 * @returns the complete file content, trailing newline included.
 */
export function serializeHarnessState(state: HarnessState): string {
  return `${JSON.stringify({ schema: HARNESS_STATE_SCHEMA, entries: state.entries, refinements: state.refinements }, null, 2)}\n`
}

/**
 * Persist one state atomically: a same-directory temp file renamed over the
 * target, so a concurrent reader observes either the old or the new complete
 * content. An existing file keeps its permission bits; a fresh one is created
 * owner-only.
 *
 * @param filePath - the store's state file path.
 * @param state - the state to persist.
 */
export async function saveHarnessState(filePath: string, state: HarnessState): Promise<void> {
  const existing = await stat(filePath).catch(() => undefined)
  const mode = existing === undefined ? HARNESS_STATE_FILE_MODE : existing.mode & 0o777
  await writeFileAtomic(filePath, serializeHarnessState(state), { mode, dirMode: HARNESS_STATE_DIR_MODE })
}
