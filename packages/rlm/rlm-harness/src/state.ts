/**
 * Pure harness-state operations shared by every consumer of the
 * `ctx.rlmHarness` seam. Normalization, merge, and refinement recording hold no
 * I/O and no clock of their own, so the seam's providers and its tests settle
 * the same state transitions.
 *
 * @module @deepseek-ai/dsh-rlm-harness/state
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  HarnessEntry,
  HarnessEntryInput,
  HarnessKind,
  HarnessRefinementProposal,
  HarnessState,
  RefinementEvent,
} from './types.ts'

/** Every entry kind, in the order a projection renders them. */
export const HARNESS_KINDS: readonly HarnessKind[] = ['prompt', 'memory', 'skill', 'subagent']

/** Default grouping path inside a kind. */
export const DEFAULT_HARNESS_PATH = 'general'

/** Default authorship marker. */
export const DEFAULT_HARNESS_SOURCE = 'agent'

/** Failure raised when a harness operation cannot be applied. */
export class HarnessStateError extends Error {
  /**
   * @param message - description of the rejected operation.
   * @param options - error options carrying the originating cause.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'HarnessStateError'
  }
}

/**
 * The empty state: every kind present and empty, no refinement history.
 *
 * @returns a fresh state with no entries and no refinements.
 */
export function emptyHarnessState(): HarnessState {
  const entries = {} as Record<HarnessKind, Record<string, HarnessEntry>>
  for (const kind of HARNESS_KINDS) entries[kind] = {}
  return { entries, refinements: [] }
}

/**
 * Normalize one caller-supplied entry into a stored record.
 *
 * @param input - the entry as the caller supplied it.
 * @param previous - the record being updated, when the call is an update.
 * @param now - the caller's clock reading for this write.
 * @returns the normalized record.
 * @throws {HarnessStateError} when the input carries no usable identity or body.
 */
export function normalizeEntry(input: HarnessEntryInput, previous: HarnessEntry | undefined, now: string): HarnessEntry {
  if (input.id.trim() === '') throw new HarnessStateError('harness entry id must not be empty')
  if (input.title.trim() === '') throw new HarnessStateError(`harness entry "${input.id}" title must not be empty`)
  if (input.content.trim() === '') throw new HarnessStateError(`harness entry "${input.id}" content must not be empty`)
  if (input.kind === 'skill' && Object.keys(input.reference ?? {}).length === 0) {
    throw new HarnessStateError(`harness skill entry "${input.id}" requires a Python reference`)
  }
  return {
    id: input.id,
    kind: input.kind,
    title: input.title,
    content: input.content,
    path: input.path ?? previous?.path ?? DEFAULT_HARNESS_PATH,
    scope: input.scope ?? previous?.scope ?? 'local',
    reference: input.reference ?? previous?.reference ?? {},
    arguments: input.arguments ?? previous?.arguments ?? {},
    metadata: input.metadata ?? previous?.metadata ?? {},
    source: input.source ?? previous?.source ?? DEFAULT_HARNESS_SOURCE,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    version: (previous?.version ?? 0) + 1,
  }
}

/**
 * Apply one entry write to a state, leaving the input untouched.
 *
 * @param state - the state to write into.
 * @param entry - the normalized record to store.
 * @returns the state with the entry stored under its kind.
 */
export function withEntry(state: HarnessState, entry: HarnessEntry): HarnessState {
  const bucket = { ...state.entries[entry.kind], [entry.id]: entry }
  return {
    entries: { ...state.entries, [entry.kind]: bucket },
    refinements: state.refinements,
  }
}

/**
 * Apply one refinement proposal and record its event.
 *
 * @param state - the state the proposal applies to.
 * @param proposal - the proposed writes and the pass's evidence.
 * @param now - the caller's clock reading for this pass.
 * @param id - the identity the caller minted for the event.
 * @returns the state after the proposal, including its recorded event.
 */
export function applyRefinement(
  state: HarnessState,
  proposal: HarnessRefinementProposal,
  now: string,
  id: string,
): HarnessState {
  let next = state
  for (const input of proposal.entries) {
    const previous = state.entries[input.kind][input.id]
    next = withEntry(next, normalizeEntry(input, previous, now))
  }
  const event: RefinementEvent = {
    id,
    trigger: proposal.trigger,
    changes: proposal.entries.map(entry => entry.id),
    evidence: proposal.evidence,
    outcome: proposal.outcome,
    createdAt: now,
  }
  return { entries: next.entries, refinements: [...next.refinements, event] }
}

/**
 * The state with every refinement after `eventId` rolled back.
 *
 * @param state - the current state.
 * @param eventId - identity of the refinement event to roll back to.
 * @returns the state truncated at that event, or the input when the event is unknown.
 */
export function rollbackToEvent(state: HarnessState, eventId: string): HarnessState {
  const index = state.refinements.findIndex(event => event.id === eventId)
  if (index < 0) return state
  return { entries: state.entries, refinements: state.refinements.slice(0, index + 1) }
}

/**
 * The JSON a projection renders for one entry.
 *
 * @param entry - the entry to project.
 * @returns the entry as a lossless JSON value.
 */
export function entryJson(entry: HarnessEntry): Readonly<Record<string, JsonValue>> {
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    content: entry.content,
    path: entry.path,
    scope: entry.scope,
    reference: entry.reference,
    arguments: entry.arguments,
    metadata: entry.metadata,
    source: entry.source,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    version: entry.version,
  }
}
