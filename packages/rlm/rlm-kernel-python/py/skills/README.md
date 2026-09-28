# dsh RLM kernel skills

English | [中文](README.zh.md)

Six Python skill packages for the CPython RLM kernel, ported from the
prime-agent bundled skills. Each package is a thin typed wrapper over the
generic host bridge (`rlm.host_request`); all state and effects live in the
TypeScript host, answered by `@deepseek-ai/dsh-rlm-bindings`:

| Import name | Wires | dsh host handlers |
|---|---|---|
| `goal` | `goal.get` / `goal.create` / `goal.complete` | `rlm-bindings/src/goal.ts` |
| `compact` | `compact.status` / `compact.run` | `rlm-bindings/src/compact.ts` |
| `refine` | `refine.status` / `refine.run` | `rlm-bindings/src/refine.ts` |
| `rlm_heartbeat` | `rlm_heartbeat.list` / `.create` / `.update` / `.delete` | `rlm-bindings/src/heartbeat.ts` |
| `agent_message` | `agent_message.send` | `rlm-bindings/src/message.ts` |
| `agent_observe` | `agent_observe.list` / `.get` / `.recent` | `rlm-bindings/src/observe.ts` |

The modules only import `host_request` and `emit` from the `rlm` runtime that
`py/rlm/` ships, so they have no third-party dependencies and work in any
interpreter that meets the kernel minimum (CPython 3.10+). The sources are
byte-identical to the prime-agent skill packages; their docstrings describe
the prime-agent host bridge, which `dsh-rlm-bindings` implements wire for
wire.

## Use inside a dsh kernel (no install)

This directory ships inside the npm package (`py/**/*.py`). Add it to the
child interpreter's module search path, either through the provider config:

```yaml
# cordis.yml
plugins:
  rlm-kernel-python:
    pythonPath:
      - /absolute/path/to/packages/rlm/rlm-kernel-python/py/skills
```

or per `acquire`:

```ts
await ctx.rlmKernel.acquire(agent, { pythonPath: [skillsDir] })
```

Then every cell can `import goal` (and the other five) directly.

## Install into a host Python (pip)

From a repository checkout, one command installs all six import packages:

```sh
python3 -m pip install packages/rlm/rlm-kernel-python/py/skills
```

Use this when the kernel runs with a host interpreter whose environment
should resolve the skills without a `pythonPath` entry, or when embedding the
skills in another Python application that provides a compatible `rlm` module.

## CLI entry points

Unlike the prime-agent packaging, this distribution registers no console
scripts: the kernel imports the modules directly, and `rlm.skill.cli` needs
`tyro`, which the kernel does not require. Run the documented async functions
from a cell instead.
