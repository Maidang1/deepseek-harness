---
description: "面向用户与维护者的宿主侧绑定：把 RLM 运行时的子代理、目标、压缩、消息、观察、精炼、心跳、模型与 MCP host 请求对接到部署内的各服务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-rlm-bindings

[English](README.md) | 中文

## Summary

`dsh-rlm-bindings` 面向组合内的服务应答 RLM Python 运行时的 `host_request` 类型：通过 `ctx.subagents` spawn 并汇聚可持续子 agent，通过 `ctx.llm` 搜索模型，通过 `ctx.goals` 管理会话目标，经调用方 agent 作用域内的引擎与 `ctx.tokenMeter` 做延迟压缩，通过 `ctx.agents` 与 `ctx.sessionQuery` 做家族消息与观察，在轮次边界调度精炼，并把心跳持久化在 DSH home 下。一次在 `ctx.rlmKernel` 上的注册即可服务每个会话的内核，调用方 agent 从每个请求的上下文读取。把它挂在内核 provider、可持续 spawn provider，以及 goal、token-meter 服务旁。

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

在任何需要 RLM 内核 spawn 子 agent、管理目标、压缩会话、家族通讯或运行心跳的组合里加载本插件。在 `rlmKernel`、`subagents`、`llm`、`sessionQuery`、`agents`、`goals` 与 `tokenMeter` 服务存在之前插件保持挂起；部署插入它的 bundle 行而缺少这些服务时，启动即大声失败。

### Minimal configuration

常见路径是一个内核 provider、一个可持续 spawn provider、session-query、goal 与 token-meter 服务、挂在 agent 可达之处的 compaction 引擎，再加本包。本包在 [`cordis.patch.yml`](cordis.patch.yml) 里自带 bundle 行，引用本包的 profile 无需手写 patch 条目即可获得绑定。

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

共应答二十八种请求类型。spawn 类请求校验载荷、同步预留兄弟间唯一的名字，并驱动一次 `startContinuable` 调用；roster 类请求读取父会话的直接子目录并折叠每个子会话的日志切面；后台命令完成时向所属会话 steer 一条通知，结果被读取时撤回仍在待发的通知。

| Request type | Behavior |
|---|---|
| `rlm.run` | spawn 一个子代理，回复其 id、名字、展示路径与模型选择子 |
| `rlm.create_session` | 同一条 spawn 路径，但由调用方预留子 id，且名字可缺省 |
| `rlm.find_models` | 搜索每个 provider 的已通告模型，最佳匹配在前 |
| `rlm.list_subagents` | 每个直接子代理一行 roster：状态、耗时、预览、进度便签 |
| `rlm.collect` | 有界等待选中的子代理收敛；超时返回当前快照，绝不报错 |
| `rlm.progress.note` | 记录一条来自子代理的、经节流的进度便签 |
| `rlm.delete_subagent` | 释放一个已收敛的子代理；仍在运行的子代理被跳过而非删除 |
| `bash.completed` | 向所属会话 steer 一条完成通知 |
| `bash.consumed` | 内核先读到结果时，撤回仍在待发的通知 |

其余类型支撑内核自带的各 skill。目标类请求驱动会话目标服务，并把它按轮数预算的相位映射到 skill 的状态词表；压缩类请求绝不在 cell 进行中压缩——`compact.run` 只记录请求，待发起方 agent 回到空闲再压缩，`compact.status` 则从 token meter 读取请求压力；精炼类请求在轮次边界向会话 steer 一条精炼通知，由 agent 自己精炼其持续 harness；心跳类请求管理一张持久化的循环提示表，按 steer 或 follow-up 投递；消息与观察类请求在一个会话的核家族——其父、兄弟与直接子代理——之间路由。

| Request type | Behavior |
|---|---|
| `goal.get` / `goal.create` / `goal.complete` | 经 `ctx.goals` 读取、创建、完成会话目标 |
| `compact.run` / `compact.status` | 调度一次空闲相位的压缩；报告 token 压力与是否已有压缩排期 |
| `model.info` | 调用方 agent 自身的路由及其接受的输入模态 |
| `mcp.config` / `mcp.refresh` | 读取一个已声明 server 的连接配置；在组合接了凭证存储时刷新存储的凭证 |
| `agent_message.send` | 向解析出的父、兄弟或子会话 steer 一条经限流的消息 |
| `agent_message.list_agents` | 恒以移除通知失败；roster 已迁至 `agent_observe.list_agents` |
| `agent_observe.list` / `agent_observe.get` / `agent_observe.recent` | 只读的家族 roster、单个成员摘要，或有界的近期消息预览 |
| `rlm_heartbeat.create` / `rlm_heartbeat.update` / `rlm_heartbeat.list` / `rlm_heartbeat.delete` | 管理持久化在 DSH home 下、按调度投递的循环提示 |
| `refine.run` / `refine.status` | 调度一次轮次边界的持续 harness 精炼；报告 pending 与 in-flight 状态 |

### What can go wrong

拒绝的 handler 会变成错误回复，发起请求的 cell 读到的是一个 `RuntimeError`，因此校验消息是模型可见文本：畸形载荷、与兄弟重名的名字、缺少 provider 分隔的模型选择子、无匹配或有歧义的 collect/delete 目标，以及来自非 RLM 子会话的进度便签，都以这种方式失败。provider 拒绝的 spawn 会释放名字预留，于是同名重试可以成功。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the bindings are built; the observable behavior is fully covered in [Use this package](#use-this-package) and the Model Experience section below.

### Design concept

本包是只拥有三份自有状态的胶水。一切持久事实——子目录、轮次计时、消息历史——都在每次调用时从 `ctx.subagents` 与 `ctx.sessionQuery` 的投影重新派生，于是宿主重启除了名字与便签什么也不丢。绑定真正拥有的是：roster，一份进程内映射，在 spawn 往返之前同步预留兄弟名字，以十秒节流携带进度便签，并把单调时钟戳在每个子代理最新观察到的事件上，使过期度只度量宿主真正清醒的时间；心跳表，DSH home 下的一个 JSON 文件，每次操作重新读取，使文件保持唯一事实来源；以及待发的精炼请求，按设计留在进程内，重启即丢弃。

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
- **A delivered completion notice cannot be withdrawn** — `bash.consumed` 只在通知仍 pending 于收件箱时撤回它；一旦被某个 step 领取，模型可能读到一条它已经取过的结果的通知。
- **`mcp.begin_login` is not registered by default** — 组合内没有交互式 OAuth 面，因此该 handler 整体不注册，由内核抛出自己的不支持请求错误；部署接入 `beginLogin` 回调后才有该 handler。
- **`mcp.refresh` and `mcp.config` have no backing store by default** — 没有接入凭证存储时每次 refresh 都大声失败；没有接入 server 目录时每个 server 都读作未声明，由内核抛出自己的「未声明」`KeyError`。
- **A goal's `token_budget` is validated but never enforced** — 目标底座按轮数而非 token 预算，被接受的预算直接丢弃；`tokens_used` 与 `time_used_seconds` 恒报零；以 `round-limit` 代码阻塞的目标映射为 `budget_limited`，其余阻塞映射为 `paused`。
- **`compact.run` accepts but never forwards custom instructions** — 压缩 seam 不接受指令文本，排定的压缩不做预检压力检查，被压缩的会话除摘要留下的通知外不会自动 resume。
- **Refinement has no separate planner pass** — 轮次边界 steer 一条通知后由 agent 自己执行精炼；pending 请求留在进程内存里，宿主重启即丢弃。
- **The heartbeat table is a plugin-private JSON file** — 心跳跨重启存活，过期的心跳在唤醒时立即补拍，但 resume 的心跳从 resume 时刻重新计拍；其他工具改动该文件可能将其损坏。
- **A message target must be live** — `agent_message.send` 只解析驻留在本宿主内的会话；没有对非活跃目标的 cold resume，发送改以 not-live 错误失败。
- **A top-level session's siblings are the live roots only** — 家族目录只列出其他驻留的顶层 agent，因此非活跃或从未加载的顶层会话不可达。
- **The roster is process-local** — 宿主重启会忘掉预留的名字、进度便签与活动戳；名字随后回落到目录标签，跨重启的两次同名 spawn 不会被拒绝。
- **Roster reads cost one observation per child** — `rlm.list_subagents` 与 `rlm.collect` 要折叠每个直接子代理的会话切面，子代理很多的父会话每次调用都要付出多次读取。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
