/**
 * Service Definition for the `ctx.rlmHarness` capability seam: the durable
 * instructions an agent refines while it works. A consumer reads the current
 * state, submits a refinement proposal, and rolls a proposal back; the provider
 * owns where the state lives and how a session replays it.
 *
 * @module @deepseek-ai/dsh-rlm-harness
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  HarnessEntry,
  HarnessEntryInput,
  HarnessKind,
  HarnessRefinementProposal,
  HarnessScope,
  HarnessScopeRef,
  HarnessState,
  RefinementEvent,
} from './types.ts'

export {
  applyRefinement,
  DEFAULT_HARNESS_PATH,
  DEFAULT_HARNESS_SOURCE,
  emptyHarnessState,
  entryJson,
  HARNESS_KINDS,
  HarnessStateError,
  normalizeEntry,
  rollbackToEvent,
  withEntry,
} from './state.ts'
export type {
  HarnessEntry,
  HarnessEntryInput,
  HarnessKind,
  HarnessRefinementProposal,
  HarnessScope,
  HarnessState,
  HarnessScopeRef,
  RefinementEvent,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    rlmHarness: HarnessRefiner
  }
}

/**
 * Readable, refinable harness state.
 *
 * One provider registers per context; loading a second throws, which is
 * Cordis' standard duplicate-service behavior.
 *
 * Implementations must honor these semantics:
 * - {@link read} returns the state as of the call, including writes another
 *   process made since this service started.
 * - {@link refine} applies the whole proposal or none of it, and records one
 *   {@link RefinementEvent} per accepted proposal.
 * - {@link rollback} removes every refinement after the named one; the entries
 *   those refinements wrote stay, because a rollback is a history operation.
 */
export abstract class HarnessRefiner extends Service {
  constructor(ctx: Context) {
    super(ctx, 'rlmHarness')
  }

  /**
   * The harness state one call addresses.
   *
   * @param scope - the session the state belongs to, or the global store when omitted.
   * @returns the current state of that scope.
   */
  abstract read(scope?: HarnessScopeRef): Promise<HarnessState>

  /**
   * Apply one refinement proposal and record its event.
   *
   * @param proposal - the proposed writes and the pass's evidence.
   * @param scope - the session the state belongs to, or the global store when omitted.
   * @returns the revision the proposal recorded.
   */
  abstract refine(proposal: HarnessRefinementProposal, scope?: HarnessScopeRef): Promise<RefinementEvent>

  /**
   * Drop every refinement after the named one.
   *
   * @param eventId - identity of the refinement event to keep as the newest.
   * @param scope - the session the state belongs to, or the global store when omitted.
   * @returns the number of refinement events removed.
   */
  abstract rollback(eventId: string, scope?: HarnessScopeRef): Promise<number>

  /**
   * Write one entry without recording a refinement event.
   *
   * @param input - the entry as the caller supplied it.
   * @param scope - the session the state belongs to, or the global store when omitted.
   * @returns the stored record.
   */
  abstract writeEntry(input: HarnessEntryInput, scope?: HarnessScopeRef): Promise<HarnessEntry>

  /**
   * Every entry of one kind.
   *
   * @param kind - the kind to list, or every kind when omitted.
   * @param scope - the session the state belongs to, or the global store when omitted.
   * @returns the stored records in insertion order.
   */
  abstract list(kind?: HarnessKind, scope?: HarnessScopeRef): Promise<readonly HarnessEntry[]>

}

/**
 * The scopes a harness state can live in.
 *
 * @returns the scope names, session-local first.
 */
export function harnessScopes(): readonly HarnessScope[] {
  return ['local', 'global']
}

export default HarnessRefiner
