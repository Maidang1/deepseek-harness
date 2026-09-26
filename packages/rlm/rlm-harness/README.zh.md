---
description: "`ctx.rlmHarness` 能力缝的 Service Definition：可持久、可精炼的 harness 指令，附可重放的精炼历史与纯状态操作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-rlm-harness

[English](README.md) | 中文

## Summary

当你编写存储可精炼 harness 状态的 provider，或读取、写入、回滚该状态的 consumer 时，使用 `dsh-rlm-harness`。缝把 harness 建模为一组带类型的条目——prompt、memory、skill、subagent persona——外加每次精炼一个记录事件，于是 session log 能在任一时点重放 harness 的样子。归一化、合并与回滚都是缝自有的纯函数，provider 与 consumer 因此对每次状态迁移达成一致。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

当你消费 `ctx.rlmHarness` 读写持久指令，或实现存储它们的 provider 时，选择本包。缝自己不注册任何东西：没有 prompt section、没有工具、没有命令。provider 拥有状态的存放位置与会话如何重放它；consumer 拥有每一处面向模型的呈现。

### Read the state

`ctx.rlmHarness.read(scope)` 返回一个作用域的完整状态——设了 `scope.sessionId` 时是该会话自己的存储，省略时是机器级存储。条目按 kind 再按 id 分组到达，精炼历史按应用顺序到达。

### Write entries

`writeEntry(input, scope)` 存一条调用方提供的记录并返回归一化、带版本的结果。`refine(proposal, scope)` 应用整个提案——每个条目写入加一个记录事件——或什么都不做，并返回该事件。`list(kind, scope)` 返回一个 kind 的条目，或省略 kind 时返回全部，按插入序排列。

### Roll back a pass

`rollback(eventId, scope)` 移除命名事件之后的每个精炼事件，并返回移除数量。那些精炼写入的条目仍然保留，因为回滚是历史操作而非状态还原；调用方若也想删掉条目就重新写一遍它们。

### What can go wrong

归一化拒绝 id 为空、标题为空、正文为空，或——`skill` kind 下——`reference` 为空的条目，抛 `HarnessStateError`。provider 的存储失败拒绝对应的 promise；本包自身不执行任何 I/O。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the seam; observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

本包是 harness 精炼能力缝的 Service Definition 角色（[capability seams](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md)）：一个抽象 `HarnessRefiner extends Service` 注册为 `ctx.rlmHarness`，外加词表与纯状态操作。由于这些操作不持 I/O、不自带时钟，provider 与其测试settle的是同一批状态迁移，审阅者读一个函数就知道一次写入意味着什么。

### One record per pass

一次精炼记录为一个 `RefinementEvent`，带它的 trigger、改动条目的 id、它的 evidence 与 outcome。条目带一个每次写入递增的单调 `version`，于是更旧的并发写入可见而非被静默覆盖。`rollback` 在一个事件处截断事件历史并刻意保留条目，这正是历史可重放的原因：重放事件重建的是过程序列，而不是状态。

### Normalization

`normalizeEntry` 填上调用方省略的每个默认值——`path`、`scope`、`reference`、`arguments`、`metadata`、`source`，以及在更新时的原 `createdAt`——并前置拒绝那四种不可用形状。结果是一条完整填充的记录，于是 provider 存储的形态与它渲染的形态是同一个。

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the abstract `HarnessRefiner` service and the seam's re-exports |
| [`src/types.ts`](src/types.ts) | Vocabulary: entries, entries-in, states, scopes, and refinement events |
| [`src/state.ts`](src/state.ts) | Pure operations: empty state, normalization, entry writes, refinement application, rollback, projection |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond the contracts its providers enforce. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the seam contract is not enough. They move from the definition to the kernel the refined instructions are written for.

- [Kernel seam](../rlm-kernel/README.zh.md) — the persistent interpreter a `skill` entry's `reference` resolves inside.
- [CPython provider](../rlm-kernel-python/README.zh.md) — the shipped kernel provider.
- [Capability seams](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md) — the Service Definition / Service Provider / Consumer split.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


这些限制界定缝做不到的事；它们是当前包约束，不是任务 backlog。

- **No storage, no clock, no model call** — 本包是契约加纯函数。状态存在哪里、会话如何重放它、一次精炼如何被提出，都是 provider 或 consumer 的关切。
- **One scope per call, no cross-scope merge** — `read`、`refine`、`rollback` 各自只针对一个作用域；把会话条目并进全局存储是调用方自建的操作。
- **A skill entry carries a reference but no resolution** — 缝记录 skill 解析到的 Python import 与 callable，这里不 import 也不校验它；解析归 kernel provider。
- **Four entry kinds, fixed** — `prompt`、`memory`、`skill`、`subagent` 就是全部集合。需要另一种 kind 的 consumer 把它存成 prompt，或存进既有 kind 的 `metadata`。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
