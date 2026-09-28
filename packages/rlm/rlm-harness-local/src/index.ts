/**
 * Service Provider for the `ctx.rlmHarness` capability seam: JSON-file harness
 * state under the DSH home. The machine-wide store lives at
 * `<dshHome>/rlm/harness/harness_state.json`; each session's local store lives
 * at `<dshHome>/rlm/harness/sessions/<sessionId>/harness_state.json`, the same
 * local/global split the reference host keeps between its session artifact
 * directory and its agent directory. Every write re-reads the file under a
 * cross-process writer lock and commits it atomically, so a session and its
 * host tools can refine the same store without losing each other's edits.
 *
 * @module @deepseek-ai/dsh-rlm-harness-local
 */

import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  applyRefinement,
  HARNESS_KINDS,
  HarnessRefiner,
  HarnessStateError,
  normalizeEntry,
  rollbackToEvent,
  withEntry,
} from '@deepseek-ai/dsh-rlm-harness'
import type {
  HarnessEntry,
  HarnessEntryInput,
  HarnessKind,
  HarnessRefinementProposal,
  HarnessScope,
  HarnessScopeRef,
  HarnessState,
  RefinementEvent,
} from '@deepseek-ai/dsh-rlm-harness'
import {
  HARNESS_STATE_DIR_MODE,
  harnessStatePath,
  harnessStoreScope,
  loadHarnessState,
  saveHarnessState,
} from './store.ts'

export {
  globalHarnessStatePath,
  HARNESS_STATE_DIR_MODE,
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
} from './store.ts'

/** Plugin configuration for the Local harness refiner. */
export interface Config {
  /** DSH home directory override; empty resolves through `DSH_HOME` or `~/.dsh`. */
  dshHome?: string
}

/** One mutation's outcome: the next state, the call's result, and whether the state changed. */
interface Mutation<T> {
  /** The state to commit when `dirty`. */
  readonly state: HarnessState
  /** The value the calling method resolves with. */
  readonly result: T
  /** Whether the mutation changed the state and therefore needs a commit. */
  readonly dirty: boolean
}

/**
 * Mint the identity of the next refinement event.
 *
 * The canonical form is the reference host's `refine_<seq>` with a zero-padded
 * sequence one past the recorded history. A rollback can free a sequence the
 * history still carries under another pass, so a collision bumps the sequence
 * until it is free.
 *
 * @param state - the state the event will be recorded into.
 * @returns an identity no recorded refinement carries.
 */
function mintRefinementId(state: HarnessState): string {
  const used = new Set(state.refinements.map(event => event.id))
  let sequence = state.refinements.length + 1
  for (;;) {
    const id = `refine_${String(sequence).padStart(4, '0')}`
    if (!used.has(id)) return id
    sequence += 1
  }
}

/**
 * Default a fresh entry's scope to the store it is written into, the way the
 * reference host stamps every upsert with its store's scope. An update that
 * omits the scope keeps the stored record's, so an entry never silently moves
 * between scopes.
 *
 * @param input - the entry as the caller supplied it.
 * @param scope - scope of the store the entry is written into.
 * @param previous - the record being updated, when the write is an update.
 * @returns the input with an explicit scope where one is needed.
 */
function withStoreScope(input: HarnessEntryInput, scope: HarnessScope, previous: HarnessEntry | undefined): HarnessEntryInput {
  return input.scope === undefined && previous === undefined ? { ...input, scope } : input
}

/**
 * JSON-file provider registering itself as `ctx.rlmHarness`.
 *
 * The provider is stateless between calls: every method re-reads the
 * addressed store from disk, and every mutation serializes its
 * read-modify-write through the store file's writer lock, so writes another
 * process committed since this service started are never clobbered and the
 * seam's "state as of the call" contract holds across processes.
 */
export class LocalHarnessRefiner extends HarnessRefiner {
  /** Validated plugin configuration; the home is changeable from `cordis.yml`. */
  static Config = z.object({
    dshHome: z.string().default(''),
  })

  /** Resolved DSH home the stores live under. */
  private readonly home: string

  constructor(ctx: Context, readonly config: Config) {
    super(ctx)
    const configured = config.dshHome
    this.home = resolveDshHome(configured === undefined || configured.trim().length === 0 ? undefined : configured)
  }

  /** The caller's clock reading for one write. */
  private now(): string {
    return new Date().toISOString()
  }

  /**
   * Run one read-modify-write against a store under its writer lock.
   *
   * @param scope - the scope the mutation addresses.
   * @param operation - the mutation, returning the next state and the call's result.
   * @returns the operation's result once the next state is committed.
   */
  private async mutate<T>(scope: HarnessScopeRef | undefined, operation: (state: HarnessState, now: string) => Mutation<T>): Promise<T> {
    const filePath = harnessStatePath(this.home, scope)
    await mkdir(dirname(filePath), { recursive: true, mode: HARNESS_STATE_DIR_MODE })
    return withFileLock(filePath, async () => {
      const now = this.now()
      const state = await loadHarnessState(filePath, harnessStoreScope(scope), now)
      const mutation = operation(state, now)
      if (mutation.dirty) await saveHarnessState(filePath, mutation.state)
      return mutation.result
    })
  }

  override async read(scope?: HarnessScopeRef): Promise<HarnessState> {
    return loadHarnessState(harnessStatePath(this.home, scope), harnessStoreScope(scope), this.now())
  }

  override async refine(proposal: HarnessRefinementProposal, scope?: HarnessScopeRef): Promise<RefinementEvent> {
    return this.mutate(scope, (state, now) => {
      const storeScope = harnessStoreScope(scope)
      const scoped: HarnessRefinementProposal = {
        ...proposal,
        entries: proposal.entries.map(input => withStoreScope(input, storeScope, state.entries[input.kind][input.id])),
      }
      const id = mintRefinementId(state)
      const next = applyRefinement(state, scoped, now, id)
      const event = next.refinements.at(-1)
      /* v8 ignore next 3 -- applyRefinement always appends exactly one event */
      if (event === undefined) {
        throw new HarnessStateError('harness refinement recorded no event')
      }
      return { state: next, result: event, dirty: true }
    })
  }

  override async rollback(eventId: string, scope?: HarnessScopeRef): Promise<number> {
    return this.mutate(scope, (state) => {
      const next = rollbackToEvent(state, eventId)
      const removed = state.refinements.length - next.refinements.length
      return { state: next, result: removed, dirty: removed > 0 }
    })
  }

  override async writeEntry(input: HarnessEntryInput, scope?: HarnessScopeRef): Promise<HarnessEntry> {
    return this.mutate(scope, (state, now) => {
      const previous = state.entries[input.kind][input.id]
      const entry = normalizeEntry(withStoreScope(input, harnessStoreScope(scope), previous), previous, now)
      return { state: withEntry(state, entry), result: entry, dirty: true }
    })
  }

  override async list(kind?: HarnessKind, scope?: HarnessScopeRef): Promise<readonly HarnessEntry[]> {
    const state = await this.read(scope)
    const kinds: readonly HarnessKind[] = kind === undefined ? HARNESS_KINDS : [kind]
    return kinds.flatMap(current => Object.values(state.entries[current]))
  }
}

export default LocalHarnessRefiner
