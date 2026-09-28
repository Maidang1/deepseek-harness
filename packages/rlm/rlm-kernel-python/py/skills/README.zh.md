# dsh RLM 内核 skill

[English](README.md) | 中文

六个面向 CPython RLM 内核的 Python skill 包，移植自 prime-agent 的内置
skill。每个包都是通用宿主桥（`rlm.host_request`）之上的薄类型封装；
全部状态与副作用都在 TypeScript 宿主侧，由
`@deepseek-ai/dsh-rlm-bindings` 应答：

| Import 名 | Wire | dsh 宿主 handler |
|---|---|---|
| `goal` | `goal.get` / `goal.create` / `goal.complete` | `rlm-bindings/src/goal.ts` |
| `compact` | `compact.status` / `compact.run` | `rlm-bindings/src/compact.ts` |
| `refine` | `refine.status` / `refine.run` | `rlm-bindings/src/refine.ts` |
| `rlm_heartbeat` | `rlm_heartbeat.list` / `.create` / `.update` / `.delete` | `rlm-bindings/src/heartbeat.ts` |
| `agent_message` | `agent_message.send` | `rlm-bindings/src/message.ts` |
| `agent_observe` | `agent_observe.list` / `.get` / `.recent` | `rlm-bindings/src/observe.ts` |

这些模块只从 `py/rlm/` 随包发布的 `rlm` 运行时 import `host_request`
和 `emit`，因此没有第三方依赖，可在满足内核最低要求的任意解释器
（CPython 3.10+）中工作。源码与 prime-agent 的 skill 包逐字节一致；
其 docstring 描述的是 prime-agent 的宿主桥，`dsh-rlm-bindings` 逐条
wire 实现了它。

## 在 dsh 内核中使用（免安装）

本目录随 npm 包发布（`py/**/*.py`）。把它加入子解释器的模块搜索路径，
可以走 provider 配置：

```yaml
# cordis.yml
plugins:
  rlm-kernel-python:
    pythonPath:
      - /absolute/path/to/packages/rlm/rlm-kernel-python/py/skills
```

或按 `acquire` 传入：

```ts
await ctx.rlmKernel.acquire(agent, { pythonPath: [skillsDir] })
```

之后每个 cell 都可以直接 `import goal`（以及其余五个）。

## 安装进宿主 Python（pip）

在仓库检出中，一条命令装齐六个 import 包：

```sh
python3 -m pip install packages/rlm/rlm-kernel-python/py/skills
```

当内核以宿主解释器运行、希望不经 `pythonPath` 条目解析 skill 时，
或把 skill 嵌入另一个提供兼容 `rlm` 模块的 Python 应用时，用这种方式。

## CLI 入口

与 prime-agent 的打包不同，本 distribution 不注册 console script：
内核直接 import 模块，而 `rlm.skill.cli` 需要 `tyro`，内核并不要求它。
请在 cell 中运行文档化的异步函数。
