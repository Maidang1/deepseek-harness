---
description: "`ctx.rlmHarness` 能力缝的 JSON 文件 provider：DSH home 下一个全局 harness 存储加每会话一个存储，带跨进程写锁与原子提交。"
kind: "package-reference"
---

# @deepseek-ai/dsh-rlm-harness-local

[English](README.md) | 中文

## Summary

当组合需要一个具体的 `ctx.rlmHarness` provider 时，使用 `dsh-rlm-harness-local`。它把可精炼的 harness 状态——prompt 注记、memory、skill、subagent persona 与精炼历史——持久化为 DSH home 下的 JSON 存储：机器级存储在 `<dshHome>/rlm/harness/harness_state.json`，会话存储在 `<dshHome>/rlm/harness/sessions/<sessionId>/harness_state.json`。每次读取都重新从磁盘加载，每次变更都在跨进程写锁下以原子提交完成，于是会话与其宿主工具共享同一份存储而不会丢彼此的编辑。

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

在任何其 agent 应当精炼持久 harness 状态——即 agent 在工作时改写的指令——的组合中加载本插件。插件把 `LocalHarnessRefiner` 注册为 `ctx.rlmHarness`，即 [`dsh-rlm-harness`](../rlm-harness/README.zh.md) 定义的缝；RLM host bindings 等 consumer 在启动时大声解析它。它不注入任何服务，因为存储位于 provider 从自身配置解析出的 DSH home 之下。

### Minimal configuration

```yaml
- insert:
    - id: rlm-harness-local
      name: '@deepseek-ai/dsh-rlm-harness-local'
      config:
        dshHome: ''
```

`dshHome` 只覆盖本 provider 的 harness home；空的默认值经由 `DSH_HOME` 再到 `~/.dsh` 解析，与每个 harness 组件遵循的优先级一致。

### What a consumer gets

缝的每个抽象方法都落在所寻址的存储上：`read(scope)` 返回调用时刻的状态，包括本服务启动后其他进程写入的内容；`writeEntry(input, scope)` 存一条带版本的记录而不记录精炼；`refine(proposal, scope)` 应用整个提案——每个条目写入加一个记录事件——或什么都不做；`rollback(eventId, scope)` 在命名事件处截断精炼历史并保留条目；`list(kind, scope)` 按插入序返回一个 kind 或全部 kind 的条目。省略 `scope` 寻址机器级存储；携带 `sessionId` 的 `scope` 寻址该会话自己的存储。

### What can go wrong

条目校验拒绝 id、标题或正文为空，以及没有 Python reference 的 `skill` 条目，抛缝的 `HarnessStateError`；被拒绝的 `refine` 不写任何东西。不是单个安全路径段的会话 id——空、`.`、`..` 或带路径分隔符——以同样方式拒绝，因为 provider 把它映射为目录名。存储失败拒绝对应的 promise。缺失、不可读或损坏的状态文件绝不抛错：它读作空状态，下一次保存会干净地重写它。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the provider; observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

本包是 harness 精炼能力缝的 Service Provider 角色（[capability seams](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md)）：它拥有状态的存放位置与会话如何重放它，而每一次状态迁移——归一化、合并、精炼记录、回滚——都委托给缝包自有的纯函数，于是 provider 与 consumer settle 的是同一批迁移。

### Two scopes, one layout

local/global 的划分镜像参照宿主：会话的存储位于该会话产物所在处，全局存储位于机器级。这里两者都位于 DSH home 的 RLM 根下——全局作用域是 `rlm/harness/harness_state.json`，每会话是 `rlm/harness/sessions/<sessionId>/harness_state.json`——与 RLM 心跳表和子会话目录相邻。磁盘形态记录一个 `schema` 版本、按 kind 再按 id 分组的条目，以及按应用序排列的精炼历史。未显式指定 scope 的新条目盖上其存储的 scope；省略 scope 的更新保留已存记录的 scope，于是条目绝不会在作用域之间静默移动。

### Cross-process writers

一次变更是在存储文件写锁（[`dsh-atomic-write`](../../util/atomic-write/README.zh.md) 的 `withFileLock`）下运行的读取-修改-写入循环，并通过把同目录临时文件 rename 到目标上来提交（`writeFileAtomic`），于是并发读者要么看到旧的完整内容、要么看到新的完整内容，两个写者也不会丢彼此的编辑。读取保持无锁。已存在的文件保留其权限位；新文件以仅属主读写创建。

### Total loading

`parseHarnessState` 逐字段重新校验每条存储记录：没有可用标题或正文的记录被跳过，旧的 `topic` 分组迁移为 `path`，不可用的 scope 回落到存储的 scope，没有时间戳的记录用加载时钟打戳。缺失、不可读或损坏的文件读作空状态，因为文件与本进程之外的写者共享，绝不能使只读它的会话崩溃。

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

- [Harness seam](../rlm-harness/README.zh.md) — the `ctx.rlmHarness` contract and the pure state operations this provider delegates to.
- [Host bindings](../rlm-bindings/README.zh.md) — the RLM runtime's refinement scheduling, the seam's primary consumer.
- [CPython provider](../rlm-kernel-python/README.zh.md) — the kernel whose model code reads and refines the harness state.
- [Atomic write](../../util/atomic-write/README.zh.md) — the writer lock and atomic replacement the mutation cycle is built from.
- [Capability seams](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md) — the Service Definition / Service Provider / Consumer split.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through [`dsh-tool-python`](../tool-python/README.zh.md) and [`dsh-rlm-bindings`](../rlm-bindings/README.zh.md), which carry the stored entries and refinement outcomes to the model inside their own surfaces.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


这些限制界定 provider 做不到的事；它们是当前包约束，不是任务 backlog。

- **One process holds no memory of the state between calls** — 每个方法都重新从磁盘读取存储，于是高频的 `list` 循环每次调用都付一次文件读；没有缓存，也没有文件 watcher 把变更发布进 context。
- **The writer lock is per store file** — 两个会话精炼各自的存储从不竞争，但两个进程精炼同一份存储会在锁的有界等待后串行，超过等待的写者失败而不是排队。
- **No cross-scope operations** — 把会话的条目合并进全局存储，或在会话之间复制条目，是调用方基于 `read` 与 `writeEntry` 自建的操作；provider 每次调用只寻址一份存储。
- **Rollback is a history operation only** — 被回滚精炼写入的条目保留在原位，与缝契约一致；调用方若也想删掉条目就重新写一遍它们。
- **No orphan lock recovery** — 崩溃的写者会留下它的 `<file>.lock` 旁文件，provider 绝不删除它，因为文件年龄不能证明属主已停止；由运维删除，与 `dsh-atomic-write` 一致。
- **Crash durability stops at the rename** — 原子提交不对文件或其父目录做 `fsync`，于是恰好发生在错误瞬间的断电可能丢掉最后一次已提交的写入，与 `dsh-atomic-write` 一致。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

local/global 划分与磁盘形态刻意镜像参照宿主（prime-agent）：它的会话级存储位于会话产物目录，全局存储位于 agent 目录，两者都叫 `harness_state.json`，带 `schema` 版本、按 kind 分组的条目与有序的精炼历史。本 provider 保留 dsh 拼写（`createdAt`/`updatedAt`、camelCase 条目字段），因为缝类型就是 dsh 词表；两边的文件不互通。

</details>
