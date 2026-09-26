---
description: "面向用户与维护者的宿主侧绑定：把 RLM 运行时的子代理、模型搜索与进度 host 请求对接到部署内的各服务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-rlm-bindings

[English](README.md) | 中文

## Summary

`dsh-rlm-bindings` 面向组合内的服务应答 RLM Python 运行时的 `host_request` 类型：通过 `ctx.subagents` spawn 并汇聚可持续子 agent，通过 `ctx.llm` 搜索已通告的模型目录，通过 `ctx.sessionQuery` 把每个子会话的日志切面折叠成 roster 行，并在每组合一份的 roster 上保存子代理进度便签。一次在 `ctx.rlmKernel` 上的注册即可服务每个会话的内核，调用方 agent 从每个请求的上下文读取。把它挂在内核 provider、可持续 spawn provider 与 session-query 服务旁。

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

在任何需要 RLM 内核 spawn 子 agent 或搜索模型的组合里加载本插件。在 `rlmKernel`、`subagents`、`llm` 与 `sessionQuery` 服务存在之前插件保持挂起；部署插入它的 bundle 行而缺少这些服务时，启动即大声失败。

### Minimal configuration

常见路径是一个内核 provider、一个可持续 spawn provider、session-query 服务，再加本包。本包在 [`cordis.patch.yml`](cordis.patch.yml) 里自带 bundle 行，引用本包的 profile 无需手写 patch 条目即可获得绑定。

```yaml
- name: '@deepseek-ai/dsh-rlm-kernel-python'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-rlm-bindings'
```

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `spawn` | 子代理创建所经的可持续 spawn provider 的注册名 |
| `dshHome` | `''` | DSH home 目录覆盖；空值经 `DSH_HOME` 或 `~/.dsh` 解析 |

生成的 [configuration catalog](../../../docs/config-catalog.zh.md#deepseek-aidsh-rlm-bindings) 是每个可接受字段的穷尽来源。`providerName` 必须指向 `ctx.subagents` 上已注册、且具备可持续创建能力的 provider，否则每次 spawn 都以 subagent 服务自身的错误失败。

### What the runtime can ask

共应答九种请求类型。spawn 类请求校验载荷、同步预留兄弟间唯一的名字，并驱动一次 `startContinuable` 调用；roster 类请求读取父会话的直接子目录并折叠每个子会话的日志切面；两条 bash 通知只做确认。

| Request type | Behavior |
|---|---|
| `rlm.run` | spawn 一个子代理，回复其 id、名字、展示路径与模型选择子 |
| `rlm.create_session` | 同一条 spawn 路径，但由调用方预留子 id，且名字可缺省 |
| `rlm.find_models` | 搜索每个 provider 的已通告模型，最佳匹配在前 |
| `rlm.list_subagents` | 每个直接子代理一行 roster：状态、耗时、预览、进度便签 |
| `rlm.collect` | 有界等待选中的子代理收敛；超时返回当前快照，绝不报错 |
| `rlm.progress.note` | 记录一条来自子代理的、经节流的进度便签 |
| `rlm.delete_subagent` | 释放一个已收敛的子代理；仍在运行的子代理被跳过而非删除 |
| `bash.completed` | 校验并确认一条后台命令的完成 |
| `bash.consumed` | 校验并确认一次结果读取 |

### What can go wrong

拒绝的 handler 会变成错误回复，发起请求的 cell 读到的是一个 `RuntimeError`，因此校验消息是模型可见文本：畸形载荷、与兄弟重名的名字、缺少 provider 分隔的模型选择子、无匹配或有歧义的 collect/delete 目标，以及来自非 RLM 子会话的进度便签，都以这种方式失败。provider 拒绝的 spawn 会释放名字预留，于是同名重试可以成功。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the bindings are built; the observable behavior is fully covered in [Use this package](#use-this-package) and the Model Experience section below.

### Design concept

本包是只拥有一份自有状态的胶水。一切持久事实——子目录、轮次计时、消息历史——都在每次调用时从 `ctx.subagents` 与 `ctx.sessionQuery` 的投影重新派生，于是宿主重启除了名字与便签什么也不丢。绑定真正拥有的是 roster：一份进程内映射，在 spawn 往返之前同步预留兄弟名字，以十秒节流携带进度便签，并把单调时钟戳在每个子代理最新观察到的事件上，使过期度只度量宿主真正清醒的时间。

### Observation folding

每一行 roster 都是对一次子会话观察的纯折叠：`subagentTiming` 投影决定运行中、已收敛或失败，`tool/call` 事件被计数，最后一条非空 assistant 消息成为压缩后的回答预览，最后一轮的结束原因成为错误文本。`rlm.collect` 以一百毫秒为间隔轮询该折叠，直到选中的子代理收敛或期限到达。

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config, service capture, handler registration, fiber-bound withdrawal |
| [`src/read.ts`](src/read.ts) | Payload readers and normalizers; every validation message matches the reference host |
| [`src/child-facts.ts`](src/child-facts.ts) | Pure folds from one child's events and timing projection to roster facts |
| [`src/roster.ts`](src/roster.ts) | The process-local roster: name reservations, progress notes, activity stamps |
| [`src/models.ts`](src/models.ts) | Model-catalog search: exact, prefix, and substring scoring over every provider |
| [`src/subagents.ts`](src/subagents.ts) | The nine handlers: spawn, roster rows, collect polling, delete, acknowledgements |
| [`cordis.patch.yml`](cordis.patch.yml) | Bundle layer inserting the bindings beside the kernel and subagent services |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond its own registration and handler calls. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the bindings' contract is not enough. They move from the seam this package consumes to the runtime whose requests it answers.

- [Kernel seam](../rlm-kernel/README.zh.md) — the `ctx.rlmKernel` contract the handlers mount on.
- [CPython provider](../rlm-kernel-python/README.zh.md) — the shipped kernel that raises the host requests.
- [`python` tool](../tool-python/README.zh.md) — the model-facing surface whose cells issue the requests.
- [Subagent seam](../../subagent/subagent/README.zh.md) — the continuable manager every spawn drives.
- [Capability seams](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md) — the Service Definition / Service Provider / Consumer split.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through [`dsh-tool-python`](../tool-python/README.zh.md), which carries the host replies' data to the model inside its own retained tool results.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


这些限制界定绑定做不到的事；它们是当前包约束，不是任务 backlog。

- **The `cwd` spawn kwarg is unsupported** — `AgentOptions` 不携带工作目录，且 `startContinuable` 不透传会话元数据，因此 `rlm.create_session` 对任何 `cwd` 都以显式错误拒绝。
- **`session_dir` and `session_file` are display paths** — 它们是 DSH home 下稳定、可读的位置，但不创建目录、不写文件；真实的会话日志布局是持久化 provider 的私事。
- **No `activity` field on roster rows** — dsh 没有表达子代理当前活动种类的投影，因此行整体省略该字段；运行时把它当作可选。
- **Bash notifications are acknowledged, not steered** — `bash.completed` 与 `bash.consumed` 只校验并回复，没有完成消息送达父会话。
- **Goal, compact, and MCP request types are unimplemented** — `goal.*`、`compact.*`、`model.info` 与 `mcp.*` 没有 handler，发出它们的运行时会得到内核响亮的我无 handler 错误。
- **The roster is process-local** — 宿主重启会忘掉预留的名字、进度便签与活动戳；名字随后回落到目录标签，跨重启的两次同名 spawn 不会被拒绝。
- **Roster reads cost one observation per child** — `rlm.list_subagents` 与 `rlm.collect` 要折叠每个直接子代理的会话切面，子代理很多的父会话每次调用都要付出多次读取。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
