---
description: "Service Definition for the `ctx.rlmHarness` capability seam: durable, refinable harness instructions with a replayable refinement history and pure state operations."
kind: "package-reference"
---

# @deepseek-ai/dsh-rlm-harness

English | [中文](README.zh.md)

## Summary

Use `dsh-rlm-harness` when you write a provider that stores refinable harness state, or a consumer that reads, writes, or rolls that state back. The seam models a harness as a set of typed entries — prompts, memories, skills, subagent personas — plus one recorded event per refinement pass, so a session log can replay what the harness looked like at any point. Normalization, merge, and rollback are pure functions the seam itself owns, which keeps provider and consumer agreeing on every state transition.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Choose this package when you consume `ctx.rlmHarness` to read or write durable instructions, or when you build a provider that stores them. The seam registers nothing on its own: no prompt section, no tool, no command. A provider owns where the state lives and how a session replays it; a consumer owns every model-facing presentation.

### Read the state

`ctx.rlmHarness.read(scope)` returns the whole state of one scope — the session's own store when `scope.sessionId` is set, the machine-wide store when omitted. Entries arrive grouped by kind and then by id, and the refinement history arrives in application order.

### Write entries

`writeEntry(input, scope)` stores one caller-supplied record and returns the normalized, versioned result. `refine(proposal, scope)` applies a whole proposal — every entry write plus one recorded event — or nothing at all, and returns the event. `list(kind, scope)` returns the entries of one kind, or every kind, in insertion order.

### Roll back a pass

`rollback(eventId, scope)` removes every refinement event after the named one and returns how many it removed. The entries those refinements wrote stay in place, because a rollback is a history operation rather than a state restore; a caller that also wants the entries gone writes them again.

### What can go wrong

Normalization rejects an entry with an empty id, an empty title, an empty body, or — for a `skill` kind — an empty `reference`, raising `HarnessStateError`. A provider's storage failures reject the corresponding promise; nothing in this package performs I/O itself.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the seam; observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The package is the Service Definition role of the harness refinement capability seam ([capability seams](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)): an abstract `HarnessRefiner extends Service` registered as `ctx.rlmHarness`, plus the vocabulary and the pure state operations. Because those operations hold no I/O and no clock of their own, a provider and its tests settle the exact same state transitions, and a reviewer can read one function to know what a write means.

### One record per pass

A refinement is recorded as a `RefinementEvent` carrying its trigger, the identities of the entries it changed, its evidence, and its outcome. Entries carry a monotonic `version` that increments on every write, so an older concurrent write is visible rather than silently overwriting. `rollback` truncates the event history at one event and deliberately leaves the entries, which is what makes the history replayable: replaying the events reconstructs the sequence of passes, not the state.

### Normalization

`normalizeEntry` fills every default the caller omitted — `path`, `scope`, `reference`, `arguments`, `metadata`, `source`, and, on an update, the original `createdAt` — and rejects the four unusable shapes up front. The result is a fully populated record, so a provider's stored form and its rendered form are the same shape.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the abstract `HarnessRefiner` service and the seam's re-exports |
| [`src/types.ts`](src/types.ts) | Vocabulary: entries, entries-in, states, scopes, and refinement events |
| [`src/state.ts`](src/state.ts) | Pure operations: empty state, normalization, entry writes, refinement application, rollback, projection |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond the contracts its providers enforce. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the seam contract is not enough. They move from the definition to the kernel the refined instructions are written for.

- [Kernel seam](../rlm-kernel/README.md) — the persistent interpreter a `skill` entry's `reference` resolves inside.
- [CPython provider](../rlm-kernel-python/README.md) — the shipped kernel provider.
- [Capability seams](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md) — the Service Definition / Service Provider / Consumer split.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the seam cannot do; they are current package constraints, not a task backlog.

- **No storage, no clock, no model call** — the package is the contract plus pure functions. Where the state lives, how a session replays it, and how a refinement pass is proposed are all a provider's or a consumer's concerns.
- **One scope per call, no cross-scope merge** — `read`, `refine`, and `rollback` each address one scope; merging a session's entries into the global store is a caller-built operation.
- **A skill entry carries a reference but no resolution** — the seam records the Python import and callable a skill resolves to, and nothing here imports or verifies it; the kernel provider owns resolution.
- **Four entry kinds, fixed** — `prompt`, `memory`, `skill`, and `subagent` are the whole set. A consumer needing another kind stores it as a prompt or as `metadata` on an existing kind.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
