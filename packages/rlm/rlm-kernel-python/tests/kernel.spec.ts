import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { RlmKernelError } from '@deepseek-ai/dsh-rlm-kernel'
import type { RlmWireEvent } from '@deepseek-ai/dsh-rlm-kernel'
import { PythonRlmKernel } from '../src/index.ts'

const PYTHON = process.env.RLM_TEST_PYTHON ?? 'python3'
const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Whether the interpreter can import the snapshot serializer. */
function hasDill(bin: string): boolean {
  try {
    execFileSync(bin, ['-c', 'import dill'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dsh-rlm-kernel-${name}-`))
  tempDirs.push(dir)
  return dir
}

function agent(id: string): Agent {
  return { id: brandString<SessionId>(id) } as Agent
}

async function kernel(pythonBin: string): Promise<PythonRlmKernel> {
  const ctx = new Context()
  await ctx.plugin(PythonRlmKernel, { pythonBin })
  return ctx.get('rlmKernel') as PythonRlmKernel
}

describe('PythonRlmKernel', () => {
  it('runs a cell and keeps its namespace for the next one', async () => {
    const service = await kernel(PYTHON)
    const handle = await service.acquire(agent('k1'))
    const first = await handle.execute('secret = [1, 2, 3]\nprint("hi")\n40 + 2')
    expect(first.status).toBe('ok')
    expect(first.stdout).toContain('hi')
    expect(first.representation).toBe('42')
    expect(first.stderr).toBe('')
    expect(first.durationMs).toBeGreaterThanOrEqual(0)
    const second = await handle.execute('print(len(secret))')
    expect(second.stdout).toContain('3')
    await service.release('k1' as SessionId)
    await service.release('unknown' as SessionId)
  })

  it('binds the runtime conveniences into the namespace at startup', async () => {
    const service = await kernel(PYTHON)
    const handle = await service.acquire(agent('k-bindings'))
    const names = await handle.execute('print(type(rlm).__name__, type(bash).__name__, type(mcp).__name__)')
    expect(names.status).toBe('ok')
    expect(names.stdout).toContain('_RLMNamespace')
    expect(names.stdout).toContain('function')
    expect(names.stdout).toContain('module')
    const viaBareBash = await handle.execute("h = bash('echo bootstrap-bound')\nimport time\ntime.sleep(0.3)\nprint(h.output().strip())")
    expect(viaBareBash.status).toBe('ok')
    expect(viaBareBash.stdout).toContain('bootstrap-bound')
    const listing = await handle.listNames()
    expect(listing).toEqual(['h', 'time'])
    await service.release('k-bindings' as SessionId)
  })

  it('reports a raising cell with its traceback and keeps serving', async () => {
    const service = await kernel(PYTHON)
    const handle = await service.acquire(agent('k2'))
    const failed = await handle.execute('raise ValueError("boom")')
    expect(failed.status).toBe('error')
    expect(failed.error?.ename).toBe('ValueError')
    expect(failed.error?.evalue).toBe('boom')
    expect(failed.error?.traceback.join('\n')).toContain('raise ValueError')
    const after = await handle.execute('1 + 1')
    expect(after.status).toBe('ok')
    await service.release('k2' as SessionId)
  })

  it('delivers every cell event to the caller in order', async () => {
    const service = await kernel(PYTHON)
    const handle = await service.acquire(agent('k3'))
    const seen: string[] = []
    await handle.execute('print("a")\n7', { onEvent: (event: RlmWireEvent) => { seen.push(event.event) } })
    expect(seen).toEqual(['stdout', 'stdout', 'result', 'done'])
    await service.release('k3' as SessionId)
  })

  it('reuses one handle for repeated acquires on one session', async () => {
    const service = await kernel(PYTHON)
    const first = await service.acquire(agent('k4'))
    const second = await service.acquire(agent('k4'))
    expect(second).toBe(first)
    await first.execute('marker = 1')
    const third = await service.acquire(agent('k4'))
    await third.execute('print(marker)')
    await service.release('k4' as SessionId)
  })

  it('interrupts a running cell without killing the kernel', async () => {
    const service = await kernel(PYTHON)
    const handle = await service.acquire(agent('k5'))
    const controller = new AbortController()
    const running = handle.execute('while True:\n    pass', { signal: controller.signal })
    setTimeout(() => { controller.abort() }, 300)
    const interrupted = await running
    expect(interrupted.status).toBe('error')
    expect(interrupted.error?.ename).toBe('KeyboardInterrupt')
    const after = await handle.execute('1 + 1')
    expect(after.status).toBe('ok')
    await service.release('k5' as SessionId)
  })

  it('captures unattributed fd output with its running cell', async () => {
    const service = await kernel(PYTHON)
    const handle = await service.acquire(agent('k6'))
    const raw = await handle.execute('import os\nos.write(1, b"raw\\n")')
    expect(raw.stdout).toContain('raw')
    await service.release('k6' as SessionId)
  })

  it('caps captured output at the configured budget', async () => {
    const ctx = new Context()
    await ctx.plugin(PythonRlmKernel, { pythonBin: PYTHON, maxOutputChars: 10 })
    const service = ctx.get('rlmKernel') as PythonRlmKernel
    const handle = await service.acquire(agent('k7'))
    const result = await handle.execute('print("x" * 500)')
    expect(result.stdout.length).toBeLessThanOrEqual(10)
    await service.release('k7' as SessionId)
  })

  it('lists the user namespace', async () => {
    const service = await kernel(PYTHON)
    const handle = await service.acquire(agent('k8'))
    await handle.execute('alpha = 1\nbeta = 2')
    await expect(handle.listNames()).resolves.toEqual(['alpha', 'beta'])
    await service.release('k8' as SessionId)
  })

  it('round-trips a snapshot when the interpreter has dill', { timeout: 20_000 }, async () => {
    if (!hasDill(PYTHON)) return
    const service = await kernel(PYTHON)
    const handle = await service.acquire(agent('k9'))
    const dir = tempDir('snapshot')
    const payload = join(dir, 'state.dill')
    const manifest = join(dir, 'state.json')
    await handle.execute('secret = [1, 2, 3]')
    const saved = await handle.snapshot({ path: payload, manifest_path: manifest })
    expect(saved.saved).toContain('secret')
    expect(saved.bytes).toBeGreaterThan(0)
    await handle.execute('secret = None')
    const restored = await handle.restore(payload)
    expect(restored.restored).toContain('secret')
    const after = await handle.execute('print(secret)')
    expect(after.stdout).toContain('[1, 2, 3]')
    await service.release('k9' as SessionId)
  })

  it('reports an empty restore for a missing snapshot', { timeout: 20_000 }, async () => {
    const service = await kernel(PYTHON)
    const handle = await service.acquire(agent('k10'))
    const restored = await handle.restore(join(tempDir('missing'), 'nothing.dill'))
    expect(restored.restored).toEqual([])
    await service.release('k10' as SessionId)
  })

  it('answers a host request from model code', async () => {
    const ctx = new Context()
    await ctx.plugin(PythonRlmKernel, { pythonBin: PYTHON })
    const service = ctx.get('rlmKernel') as PythonRlmKernel
    const handle = await service.acquire(agent('k11'), {
      hostRequests: {
        'model.info': () => Promise.resolve({ status: 'ok', result: { id: 'stub-model' } }),
      },
    })
    const result = await handle.execute('import rlm\ninfo = await rlm.host_request("model.info")\nprint(info["id"])')
    expect(result.status).toBe('ok')
    expect(result.stdout).toContain('stub-model')
    await service.release('k11' as SessionId)
  })

  it('rejects a host request with no registered handler', async () => {
    const service = await kernel(PYTHON)
    const handle = await service.acquire(agent('k12'))
    const result = await handle.execute('import rlm\nawait rlm.host_request("nope")')
    expect(result.status).toBe('error')
    await service.release('k12' as SessionId)
  })

  it('rejects work on a disposed kernel', async () => {
    const service = await kernel(PYTHON)
    const handle = await service.acquire(agent('k13'))
    await handle.dispose()
    await expect(handle.execute('1')).rejects.toThrow(RlmKernelError)
    await service.release('k13' as SessionId)
  })

  it('interrupts through the handle directly', async () => {
    const service = await kernel(PYTHON)
    const handle = await service.acquire(agent('k14'))
    const running = handle.execute('import time\nwhile True:\n    time.sleep(0.05)')
    setTimeout(() => { handle.interrupt() }, 300)
    const interrupted = await running
    expect(interrupted.status).toBe('error')
    expect(interrupted.error?.ename).toBe('KeyboardInterrupt')
    await service.release('k14' as SessionId)
  })

  it('fails loud on an unusable interpreter', async () => {
    await expect(kernel('/definitely/not/a/python')).rejects.toThrow(RlmKernelError)
  })

  it('rejects a non-positive budget at load', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(PythonRlmKernel, { pythonBin: PYTHON, maxOutputChars: 0 })).rejects.toThrow('maxOutputChars must be positive')
  })

  it('rejects an empty interpreter at load', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(PythonRlmKernel, { pythonBin: '  ' })).rejects.toThrow('pythonBin must not be empty')
  })

  it('writes a snapshot manifest beside the payload', { timeout: 20_000 }, async () => {
    if (!hasDill(PYTHON)) return
    const service = await kernel(PYTHON)
    const handle = await service.acquire(agent('k15'))
    const dir = tempDir('manifest')
    const payload = join(dir, 'state.dill')
    const manifest = join(dir, 'state.json')
    await handle.execute('secret = 1')
    await handle.snapshot({ path: payload, manifest_path: manifest })
    const before = await handle.execute('secret = 2')
    expect(before.status).toBe('ok')
    writeFileSync(payload, Buffer.from('corrupt'))
    const failed = await handle.restore(payload).catch((error: unknown) => error)
    expect(failed).toBeInstanceOf(RlmKernelError)
    await service.release('k15' as SessionId)
  })
})
