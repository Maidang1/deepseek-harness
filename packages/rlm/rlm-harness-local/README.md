---
description: "JSON-file provider for the `ctx.rlmHarness` capability seam: one global harness store and one store per session under the DSH home, with cross-process writer locking and atomic commits."
kind: "package-reference"
---

# @deepseek-ai/dsh-rlm-harness-local

English | [中文](README.zh.md)

## Summary

Use `dsh-rlm-harness-local` when a composition needs a concrete `ctx.rlmHarness` provider. It persists refinable harness state — prompt notes, memories, skills, subagent personas, and the refinement history — as JSON stores under the DSH home: one machine-wide store at `<dshHome>/rlm/harness/harness_state.json`, and one session store at `<dshHome>/rlm/harness/sessions/<sessionId>/harness_state.json`. Every read reloads from disk, and every mutation runs under a cross-process writer lock with an atomic commit, so a session and its host tools share one store without losing each other's edits.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Load this plugin in any composition whose agents should refine durable harness state — the instructions an agent rewrites while it works. The plugin registers `LocalHarnessRefiner` as `ctx.rlmHarness`, the seam [`dsh-rlm-harness`](../rlm-harness/README.md) defines; consumers such as the RLM host bindings resolve it loud at startup. It injects no services, because the stores live under the DSH home the provider resolves from its own configuration.

### Minimal configuration

```yaml
- insert:
    - id: rlm-harness-local
      name: '@deepseek-ai/dsh-rlm-harness-local'
      config:
        dshHome: ''
```

`dshHome` overrides the harness home for this provider only; the empty default resolves through `DSH_HOME` and then `~/.dsh`, the same precedence every harness component follows.

### What a consumer gets

Every abstract method of the seam lands on the addressed store: `read(scope)` returns the state as of the call, including writes another process made since this service started; `writeEntry(input, scope)` stores one versioned record without recording a refinement; `refine(proposal, scope)` applies the whole proposal — every entry write plus one recorded event — or none of it; `rollback(eventId, scope)` truncates the refinement history after the named event and leaves the entries in place; `list(kind, scope)` returns the entries of one kind or every kind in insertion order. An omitted `scope` addresses the machine-wide store; a `scope` carrying a `sessionId` addresses that session's own store.

### What can go wrong

Entry validation rejects an empty id, title, or body, and a `skill` entry without a Python reference, raising the seam's `HarnessStateError`; a rejected `refine` writes nothing. A session id that is not a single safe path segment — empty, `.`, `..`, or carrying a path separator — is rejected the same way, because the provider maps it onto a directory name. Storage failures reject the corresponding promise. A missing, unreadable, or corrupt state file never throws: it reads as the empty state, and the next save rewrites it cleanly.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the provider; observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The package is the Service Provider role of the harness refinement capability seam ([capability seams](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)): it owns where the state lives and how a session replays it, while every state transition — normalization, merge, refinement recording, rollback — is delegated to the pure functions the seam package owns, so provider and consumer settle identical transitions.

### Two scopes, one layout

The local/global split mirrors the reference host's: a session's store lives where that session's artifacts live, and the global store lives at the machine level. Here both sit under the RLM root of the DSH home — `rlm/harness/harness_state.json` for the global scope and `rlm/harness/sessions/<sessionId>/harness_state.json` per session — beside the RLM heartbeat table and child-session directories. The on-disk shape records a `schema` version, entries grouped by kind and then by id, and the refinement history in application order. A fresh entry written without an explicit scope is stamped with its store's scope; an update that omits the scope keeps the stored record's, so an entry never silently moves between scopes.

### Cross-process writers

A mutation is a read-modify-write cycle run under the store file's writer lock (`withFileLock` from [`dsh-atomic-write`](../../util/atomic-write/README.md)) and committed by renaming a same-directory temp file over the target (`writeFileAtomic`), so a concurrent reader observes either the old or the new complete content and two writers never lose each other's edits. Reads stay lock-free. An existing file keeps its permission bits; a fresh one is created owner-only.

### Total loading

`parseHarnessState` revalidates every stored record field by field: records without a usable title or body are skipped, a legacy `topic` grouping migrates to `path`, an unusable scope falls back to the store's, and records without timestamps are stamped with the load clock. A missing, unreadable, or corrupt file reads as the empty state, because the file is shared with writers outside this process and must never crash a session that only reads it.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the `LocalHarnessRefiner` service, scope routing, refinement id minting, and the locked mutation cycle |
| [`src/store.ts`](src/store.ts) | Persistence: store paths, total load, field-level normalization, and atomic save |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond the contracts its store files enforce. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the provider's contract is not enough. They move from the seam this package implements to the runtime whose refinements it persists.

- [Harness seam](../rlm-harness/README.md) — the `ctx.rlmHarness` contract and the pure state operations this provider delegates to.
- [Host bindings](../rlm-bindings/README.md) — the RLM runtime's refinement scheduling, the seam's primary consumer.
- [CPython provider](../rlm-kernel-python/README.md) — the kernel whose model code reads and refines the harness state.
- [Atomic write](../../util/atomic-write/README.md) — the writer lock and atomic replacement the mutation cycle is built from.
- [Capability seams](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md) — the Service Definition / Service Provider / Consumer split.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through [`dsh-tool-python`](../tool-python/README.md) and [`dsh-rlm-bindings`](../rlm-bindings/README.md), which carry the stored entries and refinement outcomes to the model inside their own surfaces.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the provider cannot do; they are current package constraints, not a task backlog.

- **One process holds no memory of the state between calls** — every method re-reads the store from disk, so a hot `list` loop pays one file read per call; there is no cache, and no file watcher publishes changes into the context.
- **The writer lock is per store file** — two sessions refining their own stores never contend, but two processes refining one store serialize behind the lock's bounded wait, and a writer that exceeds the wait fails instead of queueing.
- **No cross-scope operations** — merging a session's entries into the global store, or copying entries between sessions, is a caller-built operation over `read` and `writeEntry`; the provider addresses exactly one store per call.
- **Rollback is a history operation only** — entries a rolled-back refinement wrote stay in place, matching the seam contract; a caller that also wants the entries gone writes them again.
- **No orphan lock recovery** — a crashed writer leaves its `<file>.lock` sibling behind, and the provider never removes it, because file age cannot prove the owner stopped; an operator deletes it, matching `dsh-atomic-write`.
- **Crash durability stops at the rename** — the atomic commit does not `fsync` the file or its parent directory, so a power loss at the wrong instant can lose the last committed write, matching `dsh-atomic-write`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The local/global split and the on-disk shape deliberately mirror the reference host (prime-agent): its session-local store lives in the session artifact directory and its global store in the agent directory, both named `harness_state.json` with a `schema` version, kind-grouped entries, and an ordered refinement history. The provider keeps the dsh spellings (`createdAt`/`updatedAt`, camelCase entry fields) because the seam types are the dsh vocabulary; the files are not interchangeable with the reference host's.

</details>
