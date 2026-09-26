/**
 * The in-process roster of RLM children. Spawn reserves a sibling-unique name
 * synchronously, admission binds the minted child id to it, and progress notes
 * plus activity stamps accumulate against the entry. The roster is volatile:
 * every durable fact is re-derived from the session catalog and projections,
 * so a host restart simply loses names, notes, and stamps.
 *
 * @module @deepseek-ai/dsh-rlm-bindings/roster
 */

/** Minimum spacing between accepted progress notes from one child. */
export const RLM_PROGRESS_NOTE_MIN_INTERVAL_MS = 10_000

/** Bounded ring of progress notes kept per child; the newest is exposed. */
export const RLM_PROGRESS_NOTE_RING_MAX = 5

/** One admitted RLM child, keyed by its durable child session id. */
export interface RosterChild {
  /** Durable child session id, as a plain string key. */
  readonly childId: string
  /** Sibling-unique session name the child was admitted under. */
  readonly name: string
  /** The `provider/model` selector the child runs on. */
  readonly model: string
  /** One-line task label folded from the initial prompt. */
  readonly label: string
  /** Wall-clock admission time. */
  readonly createdAt: number
  /** Progress notes, newest last, capped at {@link RLM_PROGRESS_NOTE_RING_MAX}. */
  readonly notes: string[]
  /** Wall-clock time the latest note was accepted. */
  lastNoteAt?: number
  /** Event time of the newest observed log event. */
  lastActivityEventTime?: number
  /** Monotonic stamp taken when that event was first observed. */
  lastActivityMonotonicAt?: number
}

/** Identity an admitted child is registered under. */
export interface RosterAdmission {
  /** Durable child session id, as a plain string key. */
  readonly childId: string
  /** Sibling-unique session name. */
  readonly name: string
  /** The `provider/model` selector the child runs on. */
  readonly model: string
  /** One-line task label folded from the initial prompt. */
  readonly label: string
  /** Wall-clock admission time. */
  readonly createdAt: number
}

/** Outcome of one throttled progress-note submission. */
export type RosterNoteResult =
  | {
    /** The note was recorded. */
    readonly accepted: true
  }
  | {
    /** The note was throttled. */
    readonly accepted: false
    /** Milliseconds until the next note can be accepted. */
    readonly retryAfterMs: number
  }

interface ParentRoster {
  readonly byChild: Map<string, RosterChild>
  readonly byName: Map<string, string>
}

/**
 * Per-composition roster of RLM children, grouped by parent session. Name
 * reservation is synchronous so two overlapping spawns can never claim one
 * sibling name; every later lookup is O(1).
 */
export class Roster {
  private readonly parents = new Map<string, ParentRoster>()
  private readonly reservations = new Map<string, Set<string>>()
  private readonly childParent = new Map<string, string>()

  private entryOf(childId: string): RosterChild | undefined {
    const parent = this.childParent.get(childId)
    return parent === undefined ? undefined : this.parents.get(parent)?.byChild.get(childId)
  }

  /**
   * Reserve a sibling-unique child name before the spawn round trip.
   *
   * @param parent - the parent session id.
   * @param name - the requested child name.
   * @param operation - the wire type the error message names.
   * @returns a disposer releasing the reservation, for the failure path.
   */
  reserve(parent: string, name: string, operation: string): () => void {
    if (this.parents.get(parent)?.byName.has(name) === true || this.reservations.get(parent)?.has(name) === true) {
      throw new Error(`${operation} name "${name}" is already used by a sibling in the current parent session`)
    }
    let names = this.reservations.get(parent)
    if (names === undefined) {
      names = new Set()
      this.reservations.set(parent, names)
    }
    names.add(name)
    let released = false
    return () => {
      if (released) return
      released = true
      names.delete(name)
    }
  }

  /**
   * Bind a minted child id to its reserved name after admission.
   *
   * @param parent - the parent session id.
   * @param admission - the identity the child registered under.
   */
  admit(parent: string, admission: RosterAdmission): void {
    let roster = this.parents.get(parent)
    if (roster === undefined) {
      roster = { byChild: new Map(), byName: new Map() }
      this.parents.set(parent, roster)
    }
    roster.byChild.set(admission.childId, { ...admission, notes: [] })
    roster.byName.set(admission.name, admission.childId)
    this.childParent.set(admission.childId, parent)
    this.reservations.get(parent)?.delete(admission.name)
  }

  /**
   * Drop one child from the roster, e.g. after a successful delete.
   *
   * @param parent - the parent session id.
   * @param childId - the child session id.
   */
  forget(parent: string, childId: string): void {
    const roster = this.parents.get(parent)
    const entry = roster?.byChild.get(childId)
    if (roster === undefined || entry === undefined) return
    roster.byChild.delete(childId)
    roster.byName.delete(entry.name)
    this.childParent.delete(childId)
  }

  /**
   * Read one admitted child of one parent.
   *
   * @param parent - the parent session id.
   * @param childId - the child session id.
   * @returns the roster entry, when the child was admitted this process.
   */
  entry(parent: string, childId: string): RosterChild | undefined {
    return this.parents.get(parent)?.byChild.get(childId)
  }

  /**
   * Record one progress note from a child, throttled per child.
   *
   * @param childId - the noting session's id.
   * @param message - the validated note.
   * @param now - the wall-clock submission time.
   * @returns the throttle outcome, or `undefined` when the session is no RLM child.
   */
  noteProgress(childId: string, message: string, now: number): RosterNoteResult | undefined {
    const entry = this.entryOf(childId)
    if (entry === undefined) return undefined
    const last = entry.lastNoteAt
    if (last !== undefined && now - last < RLM_PROGRESS_NOTE_MIN_INTERVAL_MS) {
      return { accepted: false, retryAfterMs: RLM_PROGRESS_NOTE_MIN_INTERVAL_MS - (now - last) }
    }
    entry.lastNoteAt = now
    entry.notes.push(message)
    if (entry.notes.length > RLM_PROGRESS_NOTE_RING_MAX) entry.notes.shift()
    return { accepted: true }
  }

  /**
   * The newest progress note one child reported, when any was accepted.
   *
   * @param childId - the child session id.
   * @returns the latest note.
   */
  progressNote(childId: string): string | undefined {
    return this.entryOf(childId)?.notes.at(-1)
  }

  /**
   * Stamp the monotonic clock against one child's newest observed event time,
   * so staleness later measures only time the host was awake.
   *
   * @param childId - the child session id.
   * @param eventTime - the newest observed event time of the child log.
   * @param monotonicNow - the monotonic clock at observation time.
   */
  observeActivity(childId: string, eventTime: number, monotonicNow: number): void {
    const entry = this.entryOf(childId)
    if (entry === undefined || entry.lastActivityEventTime === eventTime) return
    entry.lastActivityEventTime = eventTime
    entry.lastActivityMonotonicAt = monotonicNow
  }

  /**
   * The monotonic stamp paired with one child's newest observed event.
   *
   * @param childId - the child session id.
   * @returns the stamp, when the child was admitted and observed.
   */
  activityMonotonicAt(childId: string): number | undefined {
    return this.entryOf(childId)?.lastActivityMonotonicAt
  }
}
