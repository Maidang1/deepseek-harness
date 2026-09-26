/**
 * Vocabulary for the `ctx.rlmHarness` capability seam: durable, refinable
 * instructions the agent rewrites during a session. The state model is small on
 * purpose — one record per entry, one event per refinement pass — so a session
 * log can replay what the harness looked like at any point.
 *
 * @module @deepseek-ai/dsh-rlm-harness/types
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Entry kinds the harness state stores. */
export type HarnessKind = 'prompt' | 'memory' | 'skill' | 'subagent'

/** Whether an entry belongs to one session or to every session on this machine. */
export type HarnessScope = 'local' | 'global'

/** One reusable prompt, memory, skill, or subagent record. */
export interface HarnessEntry {
  /** Stable identity the agent refers to this entry by. */
  readonly id: string
  readonly kind: HarnessKind
  /** Short human-readable label. */
  readonly title: string
  /** The instruction body. */
  readonly content: string
  /** Grouping path inside the kind, defaulting to `general`. */
  readonly path: string
  readonly scope: HarnessScope
  /** Skill-only: the Python import and callable the kernel resolves. */
  readonly reference: Readonly<Record<string, JsonValue>>
  /** Subagent-only: spawn arguments. */
  readonly arguments: Readonly<Record<string, JsonValue>>
  /** Free-form annotations. */
  readonly metadata: Readonly<Record<string, JsonValue>>
  /** Who authored the entry. */
  readonly source: string
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string
  /** ISO-8601 timestamp of the last write. */
  readonly updatedAt: string
  /** Monotonic revision, incremented on every write. */
  readonly version: number
}

/** One recorded refinement pass. */
export interface RefinementEvent {
  /** Stable identity of this pass. */
  readonly id: string
  /** What triggered the pass. */
  readonly trigger: string
  /** Identities of the entries the pass changed. */
  readonly changes: readonly string[]
  /** What the pass observed, for a human reviewing the history. */
  readonly evidence: string
  /** What the pass concluded. */
  readonly outcome: string
  /** ISO-8601 timestamp. */
  readonly createdAt: string
}

/** The complete harness state of one scope. */
export interface HarnessState {
  /** Entries by kind, then by id. */
  readonly entries: Readonly<Record<HarnessKind, Readonly<Record<string, HarnessEntry>>>>
  /** Refinement history in application order. */
  readonly refinements: readonly RefinementEvent[]
}

/** One entry as a caller supplies it, before normalization. */
export interface HarnessEntryInput {
  readonly id: string
  readonly kind: HarnessKind
  readonly title: string
  readonly content: string
  readonly path?: string
  readonly scope?: HarnessScope
  readonly reference?: Readonly<Record<string, JsonValue>>
  readonly arguments?: Readonly<Record<string, JsonValue>>
  readonly metadata?: Readonly<Record<string, JsonValue>>
  readonly source?: string
}

/** A refinement pass proposed for one scope. */
export interface HarnessRefinementProposal {
  /** What triggered the pass. */
  readonly trigger: string
  /** Entries to write, in application order. */
  readonly entries: readonly HarnessEntryInput[]
  /** What the pass observed. */
  readonly evidence: string
  /** What the pass concluded. */
  readonly outcome: string
}

/** Which harness state a call addresses. */
export interface HarnessScopeRef {
  /** The session the state belongs to; omitted for the global store. */
  readonly sessionId?: SessionId
}
