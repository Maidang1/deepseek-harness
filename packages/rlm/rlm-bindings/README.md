---
description: "Host-side bindings for users and maintainers composing the RLM runtime's subagent, goal, compaction, messaging, observation, refinement, heartbeat, model, and MCP host requests against a deployment's services."
kind: "package-reference"
---

# @deepseek-ai/dsh-rlm-bindings

English | [中文](README.zh.md)

## Summary

`dsh-rlm-bindings` answers the RLM Python runtime's `host_request` types against a composition's services: child spawning and fan-in through `ctx.subagents`, model search through `ctx.llm`, session goals through `ctx.goals`, deferred compaction through the calling agent's scoped engine and `ctx.tokenMeter`, family messaging and observation through `ctx.agents` and `ctx.sessionQuery`, refinement scheduling at turn boundaries, and heartbeats persisted under the DSH home. One registration on `ctx.rlmKernel` serves every session's kernel, and the calling agent is read off each request's context. Mount it beside a kernel provider, a continuable spawn provider, and the goal and token-meter services.

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

Load this plugin in any composition whose RLM kernels should spawn child agents, manage goals, compact sessions, message their family, or run heartbeats. The plugin stays inert until the `rlmKernel`, `subagents`, `llm`, `sessionQuery`, `agents`, `goals`, and `tokenMeter` services exist, and it fails loud at startup when a deployment inserts its bundle row without them.

### Minimal configuration

The common path is a kernel provider, a continuable spawn provider, the session-query, goal, and token-meter services, a compaction engine mounted where the agents can reach it, and this package. This package ships its own bundle row in [`cordis.patch.yml`](cordis.patch.yml), so a profile that adds the package gets the bindings without writing a patch entry by hand.

```yaml
- name: '@deepseek-ai/dsh-rlm-kernel-python'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-rlm-bindings'
```

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `spawn` | Registry name of the continuable spawn provider children are created through |
| `dshHome` | `''` | DSH home directory override; empty resolves through `DSH_HOME` or `~/.dsh` |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-rlm-bindings) is the exhaustive source for every accepted field. The `providerName` must name a provider registered on `ctx.subagents` whose continuable-creation capability is present, or every spawn fails with the subagent service's own error.

### What the runtime can ask

Twenty-eight request types are answered. Spawn-style requests validate their payload, reserve a sibling-unique name, and drive one `startContinuable` call; roster requests read the parent's direct-child catalog and fold each child's session cut; a background-command completion steers a notice into the owning session, and a result read withdraws it while it is still pending.

| Request type | Behavior |
|---|---|
| `rlm.run` | Spawn one child and reply with its id, name, display path, and model selector |
| `rlm.create_session` | The same spawn path with a caller-reserved child id and an optional name |
| `rlm.find_models` | Search every provider's advertised models, best matches first |
| `rlm.list_subagents` | One roster row per direct child: status, duration, preview, progress note |
| `rlm.collect` | Bounded wait for selected children to settle; a timeout returns snapshots, never an error |
| `rlm.progress.note` | Record one throttled progress note from a child |
| `rlm.delete_subagent` | Drain one settled child; a running child is skipped, not deleted |
| `bash.completed` | Steer a completion notice into the owning session |
| `bash.consumed` | Withdraw the pending notice when the kernel read the result first |

The remaining types back the kernel's bundled skills. Goal requests drive the session goal service and map its round-budgeted phases onto the skill's status vocabulary; compact requests never compact mid-cell — `compact.run` records the request and compacts once the calling agent settles to idle, while `compact.status` reads request pressure off the token meter; refinement requests steer a refinement notice into the session at the turn boundary so the agent refines its own continual harness; heartbeat requests manage a persisted table of recurring prompts delivered by steer or follow-up; message and observation requests route between a session's nuclear family — its parent, siblings, and direct children.

| Request type | Behavior |
|---|---|
| `goal.get` / `goal.create` / `goal.complete` | Read, create, and complete the session goal through `ctx.goals` |
| `compact.run` / `compact.status` | Schedule an idle-phase compaction; report token pressure and whether one is scheduled |
| `model.info` | The calling agent's own route and its accepted input modalities |
| `mcp.config` / `mcp.refresh` | Read one declared server's connection config; refresh a stored credential when the composition wires a store |
| `agent_message.send` | Steer a rate-limited message into a resolved parent, sibling, or child session |
| `agent_message.list_agents` | Always fails with the removal notice; the roster lives in `agent_observe.list_agents` |
| `agent_observe.list` / `agent_observe.get` / `agent_observe.recent` | Read-only family roster, one member's summary, or bounded recent message previews |
| `rlm_heartbeat.create` / `rlm_heartbeat.update` / `rlm_heartbeat.list` / `rlm_heartbeat.delete` | Manage recurring prompts persisted under the DSH home and delivered on schedule |
| `refine.run` / `refine.status` | Schedule a turn-boundary refinement of the continual harness; report pending and in-flight state |

### What can go wrong

A handler that rejects becomes an error reply the requesting cell reads as a `RuntimeError`, so validation messages are model-facing text: a malformed payload, a sibling-duplicate name, a model selector without a provider split, an unmatched or ambiguous collect or delete target, and a progress note from a session that is no RLM child all fail this way. A spawn whose provider rejects releases the name reservation, so a retry with the same name succeeds.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the bindings are built; the observable behavior is fully covered in [Use this package](#use-this-package) and the Model Experience section below.

### Design concept

The package is glue with three pieces of owned state. Everything durable — the child catalog, turn timing, message history — is re-derived on every call from `ctx.subagents` and `ctx.sessionQuery` projections, so a host restart loses nothing but names and notes. What the bindings do own is the roster, a process-local map that reserves sibling names synchronously before the spawn round trip, carries progress notes with a ten-second throttle, and stamps the monotonic clock against each child's newest observed event so staleness measures only time the host was awake; the heartbeat table, one JSON file under the DSH home re-read on every operation so the file stays the single source of truth; and the pending refinement requests, process-local by design because a restart drops them.

### Observation folding

Each roster row is a pure fold over one child observation: the `subagentTiming` projection decides running versus settled versus failed, `tool/call` events are counted, the last non-empty assistant message becomes the compacted answer preview, and the last turn's end reason becomes the error text. `rlm.collect` polls that fold on a hundred-millisecond interval until the selected children settle or the deadline passes.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config, service capture, handler registration, fiber-bound withdrawal |
| [`src/read.ts`](src/read.ts) | Payload readers and normalizers; every validation message matches the reference host |
| [`src/child-facts.ts`](src/child-facts.ts) | Pure folds from one child's events and timing projection to roster facts |
| [`src/roster.ts`](src/roster.ts) | The process-local roster: name reservations, progress notes, activity stamps |
| [`src/models.ts`](src/models.ts) | Model-catalog search: exact, prefix, and substring scoring over every provider |
| [`src/subagents.ts`](src/subagents.ts) | The nine spawn handlers: spawn, roster rows, collect polling, delete, completion notices |
| [`src/bash.ts`](src/bash.ts) | Completion notices: message format, steer source, and the pending-notice board |
| [`src/goal.ts`](src/goal.ts) | The goal handlers: substrate phases mapped onto the skill's wire vocabulary |
| [`src/compact.ts`](src/compact.ts) | The compact handlers: deferred idle-phase compaction and token-pressure status |
| [`src/model-info.ts`](src/model-info.ts) | The `model.info` handler: own route plus adapter-resolved modalities |
| [`src/mcp.ts`](src/mcp.ts) | The MCP handlers: config reads, credential refresh, optional interactive login |
| [`src/message.ts`](src/message.ts) | Family messaging: resolution, rate limiting, steered delivery receipts |
| [`src/observe.ts`](src/observe.ts) | Family observation: catalog derivation plus session-cut summarization |
| [`src/refine.ts`](src/refine.ts) | Refinement scheduling: pending requests, turn-boundary steering, notices |
| [`src/heartbeat.ts`](src/heartbeat.ts) | Heartbeats: schedule parsing, the JSON store, the re-armed timer scheduler |
| [`cordis.patch.yml`](cordis.patch.yml) | Bundle layer inserting the bindings beside the kernel and subagent services |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond its own registration and handler calls. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the bindings' contract is not enough. They move from the seam this package consumes to the runtime whose requests it answers.

- [Kernel seam](../rlm-kernel/README.md) — the `ctx.rlmKernel` contract the handlers mount on.
- [CPython provider](../rlm-kernel-python/README.md) — the shipped kernel that raises the host requests.
- [`python` tool](../tool-python/README.md) — the model-facing surface whose cells issue the requests.
- [Subagent seam](../../subagent/subagent/README.md) — the continuable manager every spawn drives.
- [Capability seams](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md) — the Service Definition / Service Provider / Consumer split.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through [`dsh-tool-python`](../tool-python/README.md), which carries the host replies' data to the model inside its own retained tool results.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the bindings cannot do; they are current package constraints, not a task backlog.

- **The `cwd` spawn kwarg is unsupported** — `AgentOptions` carries no working directory and `startContinuable` does not forward session metadata, so `rlm.create_session` rejects any `cwd` with an explicit error.
- **`session_dir` and `session_file` are display paths** — they are stable, human-readable locations under the DSH home, but no directory is created and no file is written; the real session log layout is the persistence provider's private business.
- **No `activity` field on roster rows** — dsh has no projection for a child's current activity kind, so rows omit the field entirely; the runtime treats it as optional.
- **A delivered completion notice cannot be withdrawn** — `bash.consumed` drops the notice only while it is still pending in the inbox; once a step claims it, the model may read about a result it already fetched.
- **`mcp.begin_login` is not registered by default** — the composition has no interactive OAuth surface, so the handler is omitted entirely and the kernel raises its own unsupported-request error; a deployment that wires a `beginLogin` callback gets the handler.
- **`mcp.refresh` and `mcp.config` have no backing store by default** — without a wired credential store every refresh fails loud, and without a wired server catalog every server reads as undeclared, so the kernel raises its own "not declared" `KeyError`.
- **A goal's `token_budget` is validated but never enforced** — the goal substrate budgets in rounds, not tokens, so the accepted budget is dropped; `tokens_used` and `time_used_seconds` always report zero, and a goal blocked with the `round-limit` code maps to `budget_limited` while any other block maps to `paused`.
- **`compact.run` accepts but never forwards custom instructions** — the compaction seam takes no instruction text, the scheduled compaction runs without a pre-flight pressure check, and a compacted session is not resumed automatically beyond the notice the summary leaves.
- **Refinement has no separate planner pass** — the turn boundary steers a notice and the agent performs the refinement itself; pending requests live in process memory, so a host restart drops them.
- **The heartbeat table is a plugin-private JSON file** — beats survive a restart and an overdue beat fires immediately on wake, but a resumed heartbeat counts its next beat from the resume moment, and other tools editing the file can corrupt it.
- **A message target must be live** — `agent_message.send` resolves only sessions resident in this host; there is no cold resume of an inactive target, and the send fails with a not-live error instead.
- **A top-level session's siblings are the live roots only** — the family catalog lists other resident top-level agents, so an inactive or never-loaded top-level session is unreachable.
- **The roster is process-local** — a host restart forgets reserved names, progress notes, and activity stamps; names then fall back to catalog labels, and two same-named spawns separated by a restart are not rejected.
- **Roster reads cost one observation per child** — `rlm.list_subagents` and `rlm.collect` fold every direct child's session cut, so a parent with many children pays many reads per call.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
