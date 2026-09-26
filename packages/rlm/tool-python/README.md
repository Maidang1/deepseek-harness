---
description: "The model-facing `python` tool for users and maintainers choosing, configuring, or debugging one-cell execution against a session's persistent Python interpreter."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-python

English | [中文](README.zh.md)

## Summary

`dsh-tool-python` registers the `python` tool, which runs one code cell in the session's persistent Python interpreter and returns its stdout, stderr, and trailing-expression repr. Every name a cell binds stays available to later cells, top-level `await` works, and an aborted call raises `KeyboardInterrupt` inside the running cell without losing the interpreter. A non-zero or raising cell is a result for the agent to interpret. Mount a kernel provider such as `dsh-rlm-kernel-python` beside the tool registry; the tool stays pending until `ctx.rlmKernel` exists.

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

Load this plugin in any composition where the agent should run Python. It registers the `python` tool once a provider of `ctx.rlmKernel` is mounted, and stays pending until the `rlmKernel` and `tools` services exist. The tool is a leaf over the kernel handle: it contributes the schema, the result rendering, and the code-length ceiling, and it forwards the execution's abort signal as a kernel interrupt.

### Minimal configuration

The common path is a kernel provider and this tool; add the tool registry when the composition does not already carry it.

This package ships its own bundle row in [`cordis.patch.yml`](cordis.patch.yml), so a profile that adds the package gets the tool without writing a patch entry by hand.

```yaml
- name: '@deepseek-ai/dsh-rlm-kernel-python'
- name: '@deepseek-ai/dsh-tool-python'
```

| Field | Default | Meaning |
|---|---|---|
| `maxCodeChars` | `100000` | Maximum number of characters one call's `code` may carry |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-python) is the exhaustive source for every accepted field; the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-python) carries the full argument schema. A non-positive `maxCodeChars` is rejected at load.

### Running a cell

One call submits one cell. The session's interpreter starts on the first call and survives across turns, so a variable bound by one cell is visible to the next, and a trailing expression is returned as its `repr`. A cell that raises or is interrupted resolves as a result whose `status` is `error`; only seam misuse raises. `bash("command")` inside a cell spawns a real subprocess without a host round trip, and the interpreter keeps serving after an interrupt.

### What can go wrong

The tool rejects an over-length `code` before submitting, reports `python: this tool requires an agent session` when executed outside a session scope, and renames any other kernel failure as `python: kernel failed: <message>`. A kernel failure that is already an `RlmKernelError` passes through unchanged, so a lost interpreter reads as a lost interpreter rather than as a cell error.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the tool is built; the observable behavior is fully covered in [Use this package](#use-this-package) and the Model Experience section below.

### Design concept

The tool is deliberately thin. It owns the model-facing contract — schema, description, ceiling, rendering, and the abort forwarding — and delegates everything else to `ctx.rlmKernel`. That keeps one implementation of the persistent namespace, the wire protocol, and the interpreter lifecycle, and lets a different provider drive the same `python` tool without the model seeing a difference.

### Abort forwarding

The execution's `AbortSignal` reaches the kernel as an interrupt rather than as a cancellation, because cancelling would end the interpreter and the namespace with it. An already-aborted signal is forwarded before the cell is submitted, so the cell lands as an interrupted one instead of running to completion.

### Result assembly

The kernel's cell result carries the status, both captured channels, the trailing `representation`, and the structured error. The tool copies the error's traceback into a fresh array and omits `representation` and `error` entirely when absent, so the declared output schema never sees a `undefined` member. `presentationMeta` reports the status, the duration, and the captured character counts, which is what a client renders without re-parsing the cell output.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the `python` tool definition, its config, and the result renderer |
| [`cordis.patch.yml`](cordis.patch.yml) | Bundle layer inserting the tool beside the kernel provider |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond its own registration and tool calls. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the tool's contract is not enough. They move from the consumer to the seam and the provider that drive it.

- [Kernel seam](../rlm-kernel/README.md) — the abstract contract the tool consumes.
- [CPython provider](../rlm-kernel-python/README.md) — the shipped provider: interpreter resolution, subprocess lifecycle, and containment.
- [PTC runtime seam](../../ptc-runtime/ptc-runtime/README.md) — the single-shot execution seam this tool deliberately does not use.
- [Capability seams](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md) — the Service Definition / Service Provider / Consumer split.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schemas

#### What the model sees

The model sees the generated [`python` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-python), which declares the single required `code` string. Agent-scoped tool restrictions can remove the definition for that agent.

#### Token effect

Fixed schema cost on every request where the tool is visible.

#### KV Cache effect

Prefix-stable while the tool definition and its visibility are unchanged. A restriction, config change, or plugin lifecycle change may invalidate reuse from this schema.

### Cell result

#### What the model sees

A successful call emits the captured stdout, then the stderr text when the cell wrote any, then the trailing expression's `repr` when the cell produced one; each is a plain text block, in that order. A raising or interrupted cell instead emits the error's value followed by its traceback lines, and the structured result carries `status` `"error"`.

##### Cell output

```markdown
<stdout>

<stderr>

<repr>
```

##### Cell error

```markdown
<error value>

<traceback line>

<traceback line>
```

#### Token effect

Zero result tokens before a call. The result is data-dependent and retained in history until compaction; per-channel capture is capped by the kernel's `maxOutputChars`.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Tool errors

#### What the model sees

Failures are normalized as `Error: <message>`. This package's stable messages are `python: code is <n> characters, over the <limit> limit`, `python: this tool requires an agent session`, and `python: kernel failed: <message>`; a kernel failure that is already an `RlmKernelError` keeps its own text.

#### Token effect

Only the failing call adds these retained tokens; no cell runs when the ceiling rejects the call.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the tool is a poor fit. They are current package constraints, not a task backlog.

- **No interactive or streaming view of a running cell** — the call resolves after the cell's `done` event; there is no partial output, progress, or cancellation-with-partial-result surface.
- **Images and rich display payloads are not surfaced** — the kernel can emit structured `display` events, and this tool does not render them; only text channels reach the model.
- **The cell ceiling is a character count, not a token count** — `maxCodeChars` bounds the submitted source, and a model can still spend its whole context arguing about a cell it never needed to write.
- **A cell's result is not diffable** — unlike an edit tool, the tool reports what ran rather than what changed, so a client cannot offer a review-and-apply gesture over it.
- **No confinement of its own** — the interpreter runs model code with shell-equivalent trust; sandboxing is the provider's concern and the shipped provider offers none.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
