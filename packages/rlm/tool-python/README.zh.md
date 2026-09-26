---
description: "模型面 `python` 工具，供选择、配置或调试针对会话持久 Python 解释器的单 cell 执行的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-python

[English](README.md) | 中文

## Summary

`dsh-tool-python` 注册 `python` 工具，它在会话的持久 Python 解释器中运行一个代码 cell，并返回其 stdout、stderr 与尾表达式 repr。cell 绑定的每个名字对后续 cell 仍然可用，顶层 `await` 可用，被中止的调用会在运行中的 cell 内引发 `KeyboardInterrupt` 而不丢失解释器。抛异常的 cell 是供 agent 解读的结果。把诸如 `dsh-rlm-kernel-python` 的 kernel provider 挂在工具注册表旁；在 `ctx.rlmKernel` 存在前工具保持 pending。

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

在任何 agent 应当运行 Python 的组合中加载本插件：一旦挂上 `ctx.rlmKernel` 的 provider 它就注册 `python` 工具，并在 `rlmKernel` 与 `tools` 服务存在前保持 pending。本工具是 kernel handle 上的一层薄壳：它贡献 schema、结果渲染与代码长度上限，并把执行的中止信号转成 kernel 中断。

### Minimal configuration

常见路径是一个 kernel provider 加本工具；组合尚未带工具注册表时再补上。

本包随附 [`cordis.patch.yml`](cordis.patch.yml) 中的 bundle 行，添加本包的 profile 无需手写 patch 条目即可获得该工具。

```yaml
- name: '@deepseek-ai/dsh-rlm-kernel-python'
- name: '@deepseek-ai/dsh-tool-python'
```

| Field | Default | Meaning |
|---|---|---|
| `maxCodeChars` | `100000` | 一次调用的 `code` 允许的最大字符数 |

生成的 [configuration catalog](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-python) 是每个可接受字段的穷尽来源；生成的 [tool catalog](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-python) 携带完整参数 schema。非正的 `maxCodeChars` 在加载时被拒绝。

### Running a cell

一次调用提交一个 cell。会话的解释器在首次调用时启动并跨轮存活，因此一个 cell 绑定的变量对下一个可见，尾表达式以其 `repr` 返回。抛异常或被中断的 cell resolve 成 `status` 为 `error` 的结果；只有缝误用才抛错。cell 内的 `bash("command")` 不经 host 往返即 spawn 真实子进程，且解释器在中断后继续服务。

### What can go wrong

工具在提交前拒绝超长 `code`，在会话作用域之外执行时报 `python: this tool requires an agent session`，并把其他任何 kernel 失败改名为 `python: kernel failed: <message>`。已经是 `RlmKernelError` 的 kernel 失败原样透传，于是解释器丢失读作解释器丢失，而不是 cell 错误。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the tool is built; the observable behavior is fully covered in [Use this package](#use-this-package) and the Model Experience section below.

### Design concept

本工具刻意薄。它拥有面向模型的契约——schema、描述、上限、渲染与中止转发——其余一切委托给 `ctx.rlmKernel`。这让持久命名空间、线协议与解释器生命周期只有一份实现，换个 provider 驱动同一个 `python` 工具时模型看不到差别。

### Abort forwarding

执行的 `AbortSignal` 以中断而非取消的形式抵达 kernel，因为取消会连解释器和命名空间一起结束。已中止的信号在 cell 提交前就转发，于是 cell 落为被中断的那个，而不是跑到底。

### Result assembly

kernel 的 cell 结果带 status、两个捕获通道、尾 `representation` 与结构化 error。工具把 error 的 traceback 复制进新数组，并在缺省时完全省略 `representation` 与 `error`，于是声明的输出 schema 永远见不到 `undefined` 成员。`presentationMeta` 报告 status、持续时间与捕获字符数，客户端据此渲染而无需重新解析 cell 输出。

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

- [Kernel seam](../rlm-kernel/README.zh.md) — the abstract contract the tool consumes.
- [CPython provider](../rlm-kernel-python/README.zh.md) — the shipped provider: interpreter resolution, subprocess lifecycle, and containment.
- [PTC runtime seam](../../ptc-runtime/ptc-runtime/README.zh.md) — the single-shot execution seam this tool deliberately does not use.
- [Capability seams](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md) — the Service Definition / Service Provider / Consumer split.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schemas

#### What the model sees

The model sees the generated [`python` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-python), which declares the single required `code` string. Agent-scoped tool restrictions can remove the definition for that agent.

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


这些限制界定本工具何时不合适。它们是当前包约束，不是任务 backlog。

- **No interactive or streaming view of a running cell** — 调用在 cell 的 `done` 事件之后才 resolve；没有部分输出、进度或带部分结果的取消界面。
- **Images and rich display payloads are not surfaced** — kernel 能发结构化 `display` 事件，本工具不渲染它们；只有文本通道抵达模型。
- **The cell ceiling is a character count, not a token count** — `maxCodeChars` 只约束提交的源码，模型仍可能为它根本不需要写的 cell 耗尽上下文。
- **A cell's result is not diffable** — 与编辑类工具不同，本工具报告的是跑了什么而不是改了什么，客户端无法在它之上提供审阅后应用的 gesture。
- **No confinement of its own** — 解释器以与 shell 同等的信任运行模型代码；沙箱是 provider 的关切，而随包发布的 provider 不提供。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
