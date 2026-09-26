---
description: "`ctx.rlmKernel` 能力缝的 Service Definition：每个 agent 会话一个持久 Python REPL，附共享线协议与 host request 词表。"
kind: "package-reference"
---

# @deepseek-ai/dsh-rlm-kernel

[English](README.md) | 中文

## Summary

当你组装一个跨多轮运行模型生成 Python 的部署、直接消费 `ctx.rlmKernel`，或实现一个驱动解释器的后端时，使用 `dsh-rlm-kernel`。一个会话只需取一次 kernel，拿到的 handle 里各 cell 共享一个跨轮存活的命名空间，输出以有序事件送达，运行中的工作可以被中断或快照。解释器与线协议归 provider；面向模型的呈现一律归 consumer。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

当你编写拥有解释器进程的 provider，或编写针对持久命名空间运行模型生成 Python 的 consumer 时，选择本包。[`dsh-rlm-kernel-python`](../rlm-kernel-python/README.zh.md) 是随包发布的 CPython provider，[`dsh-tool-python`](../tool-python/README.zh.md) 是随包发布的模型面 consumer。缝本身不持解释器、不持工具、不持会话。

### Acquire the kernel

每个会话调用一次 `ctx.rlmKernel.acquire(agent)`。第一次调用启动该会话的解释器，之后返回同一个 handle，直到 `release`。options 携带 provider 的 host request handler 与额外模块搜索路径。

```text
const handle = await ctx.rlmKernel.acquire(agent, { hostRequests })
const result = await handle.execute('total = 1 + 1', { signal })
const names = await handle.listNames()
```

### Drive one cell

`handle.execute(code, options)` 在该 cell 的 `done` 事件之后 resolve，因此 cell 产生的每个事件此时都已通过 `options.onEvent` 送达。resolve 出的结果带 status、捕获的 `stdout`/`stderr`、尾表达式的 `representation`、结构化 `error` 与 `durationMs`。options 携带调用方的 `AbortSignal`，由 provider 转成中断。

### Maintain the namespace

`handle.snapshot(request)` 通过 provider 的序列化器写出用户命名空间，并报告 `saved`、`skipped`、`pruned`；`handle.restore(path)` 读回一份，并报告 `restored` 与 `failed`。解释器缺少序列化器的 provider 会拒绝两者。`handle.interrupt()` 只停当前 cell 而不结束解释器；`handle.dispose()` 结束解释器并拒绝后续工作。

### What can go wrong

所有失败都以携带 `RlmKernelError` 的 rejected promise 到达。provider 对缝误用抛错——dispose 之后调用、解释器不可用、或向已停止的 kernel 提交 cell。cell 级失败从不 rejected：它 resolve 成一个 `status` 为 `error` 的结果，`error` 里带异常名、值与 traceback。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the seam; observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

本包是持久 kernel 能力缝的 Service Definition 角色（[capability seams](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md)）：一个抽象 `RlmKernel extends Service` 注册为 `ctx.rlmKernel`，外加 provider 与 consumer 共享的词表。kernel 刻意**不是**一次性 PTC 运行时（`ctx.ptcRuntime`）：后者约定 run 之间无状态，前者约定命名空间跨越 run 存活。拆开两者，PTC 契约仍能仅凭 session log 重建。

### Lifecycle contract

`acquire` 对同一会话的重复调用返回同一 handle，除非期间跑过 `release`，consumer 因此无需自己缓存 handle。provider 为每个会话维护一个 live entry，在会话的 `agent/disposed` 事件上 dispose 它，并在自身组合卸载时 dispose 全部 entry。`release` 幂等，对未知会话绝不 reject。

### The wire vocabulary

provider 的子进程是外部进程，因此 `parseRlmEvent` 逐字段重建每个入站帧，对无法干净重建的行返回 `undefined`——伪造帧永远搭不上车。`encodeRlmRequest` 把 host 侧写成每行一个 JSON 对象。事件为 `ready`、`stdout`、`stderr`、`result`、`display`、`host_request`、`error`、`done`；请求为 `execute`、`interrupt`、`snapshot`、`restore`、`list_names`、`shutdown`、`host_reply`。

### Host requests

cell 内的模型代码可以就自身够不到的东西向 host 发问。子进程发出带铸造 id 与 JSON 对象载荷的 `host_request` 事件，host 用同 id 的 `host_reply` 回答。缝把这一来回路类型化，并按请求类型把 handler map 交给 provider，于是每个 binding 自行拥有授权与错误映射。

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

- [CPython provider](../rlm-kernel-python/README.zh.md) — the shipped provider: interpreter resolution, subprocess lifecycle, and the JSON-lines protocol it speaks.
- [`python` tool](../tool-python/README.zh.md) — the model-facing consumer that runs one cell per call.
- [PTC runtime seam](../../ptc-runtime/ptc-runtime/README.zh.md) — the single-shot execution seam this one deliberately does not replace.
- [Capability seams](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md) — the Service Definition / Service Provider / Consumer split.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


这些限制界定缝无法表达的东西；它们是当前包约束，不是任务 backlog。

- **No interpreter, no protocol implementation** — 本包定义契约并校验线协议；进程、生命周期与序列化器由 provider 提供。这里不运行 Python。
- **One kernel per session, never a pool** — 一个会话的各 cell 共用一个解释器和一个命名空间，于是 handle 是一个串行点。跨会话并发属于组装层关切。
- **Host requests are advisory** — 缝给这一来回路定了型，但无法强制 provider 实现任何特定请求类型；未实现的类型在 cell 内 resolve 为一条错误回复。
- **Snapshots are provider-dependent** — 每个 handle 上都有 `snapshot`/`restore`，但命名空间能否跨重启存活完全取决于 provider 的序列化器是否可用。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
