---
description: "CPython subprocess provider for the `ctx.rlmKernel` seam: the shipped backend that runs one persistent Python interpreter per agent session, with its bundled runtime and validated Config."
kind: "package-reference"
---

# @deepseek-ai/dsh-rlm-kernel-python

English | [中文](README.zh.md)

## Summary

Use `dsh-rlm-kernel-python` when you compose a deployment that runs model-written Python and want a persistent CPython backend. The provider ships its Python runtime in the npm package and registers `PythonRlmKernel` as `ctx.rlmKernel`, so one interpreter per session starts on first use and keeps its namespace across turns and compactions. Configuration is validated at load: a non-positive cap, an unset interpreter, or an interpreter that is not a supported CPython fails before the service exists.

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

Choose this package when a composition needs the CPython provider of `ctx.rlmKernel`. Mount it beside the tool registry, then mount a consumer such as [`dsh-tool-python`](../tool-python/README.md). The provider is a Service Provider of the seam ([capability seams](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)); it registers nothing the model sees itself.

### Mount and configure

Register the provider as a bundle layer, a profile patch row, or a plugin entry. Every cap is a validated `Config` field with a default.

| Field | Default | Meaning |
|---|---|---|
| `pythonBin` | `python3` | Absolute executable path, or a bare name resolved through `PATH` |
| `pythonPath` | `[]` | Extra directories appended to the child's module search path |
| `maxOutputChars` | `65536` | Per-channel capture cap in characters |
| `startupTimeoutMs` | `30000` | Ceiling on the startup handshake |
| `shutdownGraceMs` | `3000` | Grace period between `shutdown` and `SIGKILL` |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-rlm-kernel-python) is the exhaustive source for every accepted field. An empty or whitespace-only `pythonBin` is rejected at load, as is any non-positive cap; an interpreter that cannot run, or is not CPython 3.10 or newer, is rejected at load as well, so a broken deployment fails once instead of on every cell.

### What the session experiences

`acquire(agent)` spawns `python -u -m rlm.repl` from the package's own `py/` directory, then waits for the `ready` handshake. Cells then run in one namespace that survives turns, a trailing expression is returned as its `repr`, and an `AbortSignal` on the cell raises `KeyboardInterrupt` inside the running code without ending the interpreter. `bash("command")` inside a cell spawns a real subprocess and needs no host round trip. Output that arrives with no cell attribution — bytes written directly to a file descriptor by a child process — is retained and attached to whichever cell is running.

### Teardown and recovery

A session's interpreter is stopped when that session's `agent/disposed` event fires, and every interpreter of the composition is stopped when the provider itself unloads. Teardown writes `shutdown` on stdin, ends the pipe, and escalates to `SIGKILL` only after `shutdownGraceMs`. `snapshot` and `restore` round-trip the user namespace through `dill`; when the interpreter has no `dill`, both fail inside the cell and the namespace is simply lost across a restart.

### What can go wrong

A startup failure — an interpreter that exits before the handshake, a `spawn` error, or a startup timeout — rejects `acquire` with an `RlmKernelError` whose message carries the tail of the child's stderr. A cell that raises resolves as a result whose `status` is `error`; only misuse of the seam rejects. Cell output is capped per channel at `maxOutputChars`, and the cap keeps the newest characters.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the backend; observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

One direction of trust: the host treats every inbound line as hostile (model code can forge anything on stdout) and rebuilds it field by field through the seam's validator; the Python side trusts host replies. One persistent interpreter per session is what makes the namespace survive turns, and it is also why the handle is a serialization point: the interpreter runs one cell at a time, the provider attributes every event to the oldest in-flight cell, and callers are expected to submit cells one at a time.

### Process model

The child is `python -u -m rlm.repl`, spawned with the package's `py/` directory first on `PYTHONPATH`, then `pythonPath`, then any path the caller passed to `acquire`. `stdio` is three pipes: stdin carries requests, stdout carries events, stderr carries only startup diagnostics. A `readline` loop drives the events, and the same loop settles the startup promise, so a process that dies mid-handshake is indistinguishable from one that never announces itself.

### Containment

The child is not a security boundary: model code holds shell-equivalent trust, and `bash()` spawns real subprocesses. What the provider does contain is resource shape — a per-channel output cap, a startup deadline, a shutdown grace period, and `SIGKILL` when the child ignores `shutdown`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `PythonRlmKernel` — spawn, event pump, request routing, lifecycle, teardown |
| [`src/python.ts`](src/python.ts) | Interpreter resolution: version parsing, support range, fail-loud probe |
| [`py/rlm/repl.py`](py/rlm/repl.py) | Child side: request loop, namespace, display bridge, snapshot serializer client |
| [`py/rlm/bash.py`](py/rlm/bash.py) | Child side: the `bash()` builtin and its background job table |
| [`cordis.patch.yml`](cordis.patch.yml) | Bundle layer inserting the provider beside the tool registry |
| — | No runtime invariant companion is published: lifecycle and teardown live in the CPython child or on its pipes, so this package exposes no same-process event sequence for a Cordis listener to compare; the real-subprocess suite covers those process-boundary behaviors. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the provider's configuration is not enough. They move from the seam definition to the model-facing consumer and the runtime's own contract.

- [Kernel seam](../rlm-kernel/README.md) — the abstract contract this provider implements.
- [`python` tool](../tool-python/README.md) — the model-facing consumer that runs one cell per call.
- [`py/rlm/repl.md`](py/rlm/repl.md) — the child runtime's own protocol and behavior record.
- [Capability seams](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md) — the Service Definition / Service Provider / Consumer split.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through [`dsh-tool-python`](../tool-python/README.md), which renders each cell's status, output, and errors into its own retained tool result.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the provider cannot do; they are current package constraints, not a task backlog.

- **The child is not a security boundary** — model code holds shell-equivalent trust: direct file operations have no sandbox, and `bash()` spawns real subprocesses. Only output caps and the shutdown deadline contain runaway work.
- **One interpreter per session, started lazily** — every session that runs a cell spawns a live CPython process with its own memory footprint; sessions that never call the `python` tool pay nothing, but a subagent that calls it once pays for its own interpreter.
- **`dill` is required for snapshots** — `snapshot`/`restore` round-trip through `dill`; without it, a restart loses the namespace and the failure is reported inside the cell rather than at load.
- **No automatic package installation** — the provider does not create a virtual environment or install extras; `pythonPath` is the only extension mechanism, and a missing third-party import is an ordinary cell error.
- **Interrupt is advisory for threaded work** — `KeyboardInterrupt` is delivered to the interpreter's main thread, so a cell that spawned a non-daemon worker thread can still hold the kernel until that thread finishes.
- **Concurrent cells share one attribution window** — the provider attributes every event to the oldest in-flight cell, so two overlapping `execute` calls on one handle interleave their captured output instead of failing fast. Consumers submit cells one at a time; the `python` tool does so by construction.
- **No host request bindings ship by default** — `acquire` accepts a handler map, and an unhandled request type resolves to an error reply inside the cell; every binding is the caller's to implement.
- **Windows is untested** — the provider spawns through the platform's `spawn`, but the shipped `py/` runtime and its process handling are exercised on POSIX platforms only.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
