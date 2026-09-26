---
description: "Service Definition for the `ctx.rlmKernel` capability seam: one persistent Python REPL per agent session, with the shared wire protocol and host-request vocabulary."
kind: "package-reference"
---

# @deepseek-ai/dsh-rlm-kernel

English | [中文](README.zh.md)

## Summary

Use `dsh-rlm-kernel` when you compose a deployment that runs model-written Python across several turns, consume `ctx.rlmKernel` directly, or build a backend that drives an interpreter. A session asks for its kernel once and receives a handle whose cells run in one namespace that survives turns, whose output arrives as ordered events, and whose work an operator can interrupt or snapshot. Providers own the interpreter and the wire protocol; consumers own every model-facing presentation.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Choose this package when you write a provider that owns an interpreter process, or a consumer that runs model-written Python against a persistent namespace. [`dsh-rlm-kernel-python`](../rlm-kernel-python/README.md) is the shipped CPython provider and [`dsh-tool-python`](../tool-python/README.md) is the shipped model-facing consumer. The seam itself holds no interpreter, no tool, and no session.

### Acquire the kernel

Call `ctx.rlmKernel.acquire(agent)` once per session. The first call starts the session's interpreter; later calls return the same handle until `release` runs. Options carry the provider's host request handlers and any extra module search path.

```text
const handle = await ctx.rlmKernel.acquire(agent, { hostRequests })
const result = await handle.execute('total = 1 + 1', { signal })
const names = await handle.listNames()
```

### Drive one cell

`handle.execute(code, options)` resolves after the cell's `done` event, so every event the cell produced has already been delivered through `options.onEvent`. The resolved result carries the status, the captured `stdout`/`stderr`, the trailing expression's `representation`, any structured `error`, and the `durationMs`. Options carry the caller's `AbortSignal`, which the provider forwards as an interrupt.

### Maintain the namespace

`handle.snapshot(request)` writes the user namespace through the provider's serializer and reports what was `saved`, `skipped`, and `pruned`; `handle.restore(path)` reads one back and reports what was `restored` or `failed`. A provider whose interpreter lacks the serializer rejects both. `handle.interrupt()` stops the running cell without ending the interpreter, and `handle.dispose()` stops it and rejects further work.

### What can go wrong

Every failure arrives as a rejected promise carrying `RlmKernelError`. A provider throws for seam misuse — a call after disposal, an unusable interpreter, or a cell submitted to a kernel that already stopped. Cell-level failures are never rejections: they resolve as a result whose `status` is `error` and whose `error` carries the exception name, value, and traceback.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the seam; observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The package is the Service Definition role of the persistent-kernel capability seam ([capability seams](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)): an abstract `RlmKernel extends Service` registered as `ctx.rlmKernel`, plus the vocabulary every provider and consumer shares. A kernel is deliberately *not* the single-shot PTC runtime (`ctx.ptcRuntime`): that seam contracts for no state between runs, while this one contracts for a namespace that survives them. Splitting the two keeps the PTC contract reconstructable from a session log alone.

### Lifecycle contract

`acquire` returns the same handle for repeated calls on one session unless `release` ran in between, so a consumer never has to cache the handle itself. A provider keeps a live entry per session, disposes it on the session's `agent/disposed` event, and disposes every entry when its own composition unloads. `release` is idempotent and never rejects for an unknown session.

### The wire vocabulary

A provider's child process is a foreign subprocess, so `parseRlmEvent` rebuilds every inbound frame field by field and returns `undefined` for a line that does not rebuild cleanly — a forged frame never rides along. `encodeRlmRequest` writes the host side out as one JSON object per line. The events are `ready`, `stdout`, `stderr`, `result`, `display`, `host_request`, `error`, and `done`; the requests are `execute`, `interrupt`, `snapshot`, `restore`, `list_names`, `shutdown`, and `host_reply`.

### Host requests

Model code inside a cell can ask the host for something it cannot reach itself. The child emits a `host_request` event with a minted id and a JSON object payload, and the host answers it with a `host_reply` carrying the same id. The seam types the round trip and hands the provider a handler map keyed by request type, so each binding owns its own authorization and error mapping.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the abstract `RlmKernel` service and the seam's re-exports |
| [`src/types.ts`](src/types.ts) | Vocabulary: handle, events, requests, host replies, and snapshot results |
| [`src/protocol.ts`](src/protocol.ts) | Wire constants plus hostile-line rebuilding for every inbound event |
| [`src/error.ts`](src/error.ts) | The failure type every provider of this seam raises |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond the contracts its providers enforce. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the seam contract is not enough. They move from the definition to the shipped provider, the model-facing consumer, and the design model.

- [CPython provider](../rlm-kernel-python/README.md) — the shipped provider: interpreter resolution, subprocess lifecycle, and the JSON-lines protocol it speaks.
- [`python` tool](../tool-python/README.md) — the model-facing consumer that runs one cell per call.
- [PTC runtime seam](../../ptc-runtime/ptc-runtime/README.md) — the single-shot execution seam this one deliberately does not replace.
- [Capability seams](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md) — the Service Definition / Service Provider / Consumer split.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the seam cannot express; they are current package constraints, not a task backlog.

- **No interpreter, no protocol implementation** — the package defines the contract and validates the wire; a provider supplies the process, the lifecycle, and the serializer. Nothing here runs Python.
- **One kernel per session, never a pool** — cells of one session share one interpreter and one namespace, so the handle is a serialization point. Cross-session concurrency is a composition concern.
- **Host requests are advisory** — the seam types the round trip but cannot force a provider to implement any particular request type; an unimplemented type resolves to an error reply inside the cell.
- **Snapshots are provider-dependent** — `snapshot`/`restore` exist on every handle, but whether a namespace survives a restart depends entirely on the provider's serializer being available.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
