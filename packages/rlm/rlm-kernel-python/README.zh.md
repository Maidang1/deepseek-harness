---
description: "`ctx.rlmKernel` 缝的 CPython 子进程 provider：随包发布的后端，每个 agent 会话一个持久 Python 解释器，附运行时与经校验的 Config。"
kind: "package-reference"
---

# @deepseek-ai/dsh-rlm-kernel-python

[English](README.md) | 中文

## Summary

当你组装一个运行模型生成 Python 并希望有持久 CPython 后端的部署时，使用 `dsh-rlm-kernel-python`。provider 把它的 Python 运行时随 npm 包发布，并注册 `PythonRlmKernel` 为 `ctx.rlmKernel`，于是每个会话一个解释器在首次使用时启动，其命名空间跨轮与压缩存活。配置在加载时校验：非正上限、未设置的解释器，或不受支持的 CPython，都会在服务存在之前就失败。

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

当一个组合需要 `ctx.rlmKernel` 的 CPython provider 时，选择本包。把它挂在工具注册表旁，再挂一个诸如 [`dsh-tool-python`](../tool-python/README.zh.md) 的 consumer。本包是缝的 Service Provider（[capability seams](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md)）；它自己不注册任何模型可见之物。

### Mount and configure

把 provider 注册为 bundle 层、profile patch 行或插件条目。每个上限都是带默认值的、经校验的 `Config` 字段。

| Field | Default | Meaning |
|---|---|---|
| `pythonBin` | `python3` | 绝对可执行路径，或经 `PATH` 解析的裸命令名 |
| `pythonPath` | `[]` | 追加到子进程模块搜索路径的额外目录 |
| `maxOutputChars` | `65536` | 每通道捕获上限（字符） |
| `startupTimeoutMs` | `30000` | 启动握手的时间上限 |
| `shutdownGraceMs` | `3000` | `shutdown` 与 `SIGKILL` 之间的宽限期 |

生成的 [configuration catalog](../../../docs/config-catalog.zh.md#deepseek-aidsh-rlm-kernel-python) 是每个可接受字段的穷尽来源。空或全空白的 `pythonBin` 在加载时即被拒绝，任何非正上限亦然；无法运行、或不是 CPython 3.10 及更新的解释器同样在加载时被拒绝，于是坏部署失败一次，而不是每个 cell 失败一次。

### What the session experiences

`acquire(agent)` 从包自带的 `py/` 目录 spawn `python -u -m rlm.repl`，等待 `ready` 握手，然后执行一个 bootstrap cell，把运行时的便利设施——`rlm` 命名空间、`bash()` 与 `mcp` 模块——绑定进用户命名空间，模型代码无需显式 import 即可调用。bootstrap 失败会让 acquire 失败，而不是拖到第一个用户 cell 才暴露。随后各 cell 在一个跨轮存活的命名空间中运行，尾表达式以其 `repr` 返回，cell 上的 `AbortSignal` 会在运行中的代码内引发 `KeyboardInterrupt` 而不结束解释器。cell 内的 `bash("command")` spawn 真实子进程，不需要 host 往返。以无归属方式到达的输出——子进程直接写文件描述符的字节——会被保留并附着到正在运行的 cell 上。

### Teardown and recovery

会话的解释器在该会话的 `agent/disposed` 事件触发时停止，provider 自身卸载时组合内每个解释器都停止。拆除在 stdin 上写 `shutdown`、关闭管道，只在 `shutdownGraceMs` 之后升级到 `SIGKILL`。`snapshot` 与 `restore` 通过 `dill` 往返用户命名空间；解释器没有 `dill` 时两者在 cell 内失败，重启即丢失命名空间。

### What can go wrong

启动失败——解释器在握手前退出、`spawn` 出错、或启动超时——以携带子进程 stderr 尾部的 `RlmKernelError` 拒绝 `acquire`。抛异常的 cell resolve 成 `status` 为 `error` 的结果；只有缝误用才拒绝。cell 输出按通道以 `maxOutputChars` 设上限，上限保留的是最新字符。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the backend; observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

单向信任：host 把每一行入站内容都当作敌意（模型代码可以在 stdout 上伪造任何东西），并通过缝的校验器逐字段重建；Python 侧信任 host 回复。每会话一个持久解释器正是命名空间跨轮存活的原因，也正是 handle 成为串行点的原因：解释器一次运行一个 cell，provider 把每个事件归属到最早就绪的 cell，调用方被期望一次提交一个 cell。

### Process model

子进程是 `python -u -m rlm.repl`，spawn 时包的 `py/` 目录排在 `PYTHONPATH` 最前，其后是 `pythonPath`，再其后是调用方传给 `acquire` 的路径。`stdio` 是三根管道：stdin 承载请求，stdout 承载事件，stderr 只承载启动诊断。一个 `readline` 循环驱动事件，同一个循环 settle 启动 promise，于是在握手中途死掉的进程与从未自报家门的进程不可区分。

### Containment

子进程不是安全边界：模型代码持有与 shell 同等的信任，`bash()` 会 spawn 真实子进程。provider 真正约束的是资源形状——每通道输出上限、启动期限、shutdown 宽限期，以及子进程无视 `shutdown` 时的 `SIGKILL`。

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

- [Kernel seam](../rlm-kernel/README.zh.md) — the abstract contract this provider implements.
- [`python` tool](../tool-python/README.zh.md) — the model-facing consumer that runs one cell per call.
- [`py/rlm/repl.md`](py/rlm/repl.md) — the child runtime's own protocol and behavior record.
- [Capability seams](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md) — the Service Definition / Service Provider / Consumer split.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through [`dsh-tool-python`](../tool-python/README.zh.md), which renders each cell's status, output, and errors into its own retained tool result.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


这些限制界定 provider 做不到的事；它们是当前包约束，不是任务 backlog。

- **The child is not a security boundary** — 模型代码持有与 shell 同等的信任：直接文件操作没有沙箱，`bash()` 会 spawn 真实子进程。只有输出上限与 shutdown 期限在约束失控工作。
- **One interpreter per session, started lazily** — 每个跑过 cell 的会话都会 spawn 一个活着的 CPython 进程，各占一份内存；从不调用 `python` 工具的会话不付代价，但调用过一次的子 agent 要为它自己的解释器付费。
- **`dill` is required for snapshots** — `snapshot`/`restore` 通过 `dill` 往返；没有它，重启即丢失命名空间，且失败在 cell 内报告而不是在加载时。
- **No automatic package installation** — provider 不创建虚拟环境、不安装 extras；`pythonPath` 是唯一的扩展机制，缺失的第三方 import 就是普通 cell 错误。
- **Interrupt is advisory for threaded work** — `KeyboardInterrupt` 只投递给解释器主线程，因此 spawn 了非守护线程的 cell 仍可能hold 住 kernel 直到该线程结束。
- **Concurrent cells share one attribution window** — provider 把每个事件归属到最早就绪的 cell，于是同一 handle 上两个重叠的 `execute` 会交错它们的捕获输出，而不是快速失败。consumer 一次提交一个 cell；`python` 工具依构造即如此。
- **No host request bindings ship by default** — `acquire` 接受 handler map，未处理的请求类型在 cell 内 resolve 为错误回复；每个 binding 都由调用方自行实现。
- **Windows is untested** — provider 通过平台的 `spawn` 启动进程，但随包发布的 `py/` 运行时及其进程处理只在 POSIX 平台上验证过。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
