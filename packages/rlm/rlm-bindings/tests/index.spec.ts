import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { ContinuableStartSpec } from '@deepseek-ai/dsh-subagent'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { RlmKernel } from '@deepseek-ai/dsh-rlm-kernel'
import type { RlmHostRequestHandlers, RlmKernelHandle } from '@deepseek-ai/dsh-rlm-kernel'
import { apply, inject, name } from '../src/index.ts'

function agent(id: string, options: Agent['options'] = {}): Agent {
  const session = Session.create(SessionId(id), [], {
    version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 0, cwd: '/repo', isSeeded: false,
  })
  return {
    id: SessionId(id),
    options,
    session,
    inbox: unsupportedInbox(),
    ctx: new Context(),
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

class StubKernel extends RlmKernel {
  activeRegistrations = 0
  handlers: RlmHostRequestHandlers = {}

  acquire = (): Promise<RlmKernelHandle> => Promise.reject(new Error('no kernel'))
  release = (): Promise<void> => Promise.resolve()

  override registerHostRequestHandlers(handlers: RlmHostRequestHandlers): () => void {
    this.handlers = handlers
    this.activeRegistrations += 1
    const withdraw = super.registerHostRequestHandlers(handlers)
    return () => {
      this.activeRegistrations -= 1
      withdraw()
    }
  }
}

const EXPECTED_TYPES = [
  'rlm.run',
  'rlm.create_session',
  'rlm.find_models',
  'rlm.list_subagents',
  'rlm.collect',
  'rlm.progress.note',
  'rlm.delete_subagent',
  'bash.completed',
  'bash.consumed',
]

async function setup(config?: Parameters<typeof apply>[1]) {
  const ctx = new Context()
  await ctx.plugin(StubKernel)
  const kernel = ctx.rlmKernel as StubKernel
  const starts: ContinuableStartSpec[] = []
  ctx.provide('subagents', {
    startContinuable: (spec: ContinuableStartSpec) => {
      starts.push(spec)
      return Promise.resolve({ childId: SessionId('kid-1'), messageId: MessageId('m') })
    },
    listChildren: () => Promise.resolve([]),
    drainContinuableChildren: () => Promise.resolve(),
  } as never)
  ctx.provide('llm', {
    listProviders: () => [],
    listModels: () => Promise.resolve([]),
  } as never)
  ctx.provide('sessionQuery', {
    observeSession: () => Promise.resolve({ events: [], [Symbol.dispose]: () => {} }),
  } as never)
  apply(ctx, config)
  return { ctx, kernel, starts }
}

describe('rlm-bindings plugin', () => {
  it('names itself and declares its service dependencies', () => {
    expect(name).toBe('rlm-bindings')
    expect(inject).toEqual(['rlmKernel', 'subagents', 'llm', 'sessionQuery'])
  })

  it('registers all nine host handlers and withdraws them on dispose', async () => {
    const { ctx, kernel } = await setup()
    expect(Object.keys(kernel.handlers).sort()).toEqual([...EXPECTED_TYPES].sort())
    expect(kernel.activeRegistrations).toBe(1)
    await ctx.fiber.dispose()
    expect(kernel.activeRegistrations).toBe(0)
  })

  it('spawns through the configured provider and reports the default home paths', async () => {
    const { kernel, starts } = await setup()
    const reply = await kernel.handlers['rlm.run']!(
      { event: 'host_request', id: '1', data: { type: 'rlm.run', prompt: 'x', kwargs: { name: 'alpha' } } },
      { agent: agent('parent-1', { provider: 'p0', model: 'm0' }), signal: new AbortController().signal },
    )
    expect(starts[0]?.provider).toBe('spawn')
    expect(reply).toEqual({
      status: 'ok',
      result: {
        rlm_child_id: 'kid-1',
        name: 'alpha',
        session_dir: join(resolveDshHome(), 'rlm', 'children', 'kid-1'),
        model: 'p0/m0',
      },
    })
  })

  it('honors a custom provider name and dsh home', async () => {
    const { kernel, starts } = await setup({ providerName: 'custom-spawn', dshHome: '/tmp/rlm-bindings-test' })
    const reply = await kernel.handlers['rlm.run']!(
      { event: 'host_request', id: '1', data: { type: 'rlm.run', prompt: 'x', kwargs: { name: 'alpha' } } },
      { agent: agent('parent-1', { provider: 'p0', model: 'm0' }), signal: new AbortController().signal },
    )
    expect(starts[0]?.provider).toBe('custom-spawn')
    expect(reply).toEqual({
      status: 'ok',
      result: {
        rlm_child_id: 'kid-1',
        name: 'alpha',
        session_dir: '/tmp/rlm-bindings-test/rlm/children/kid-1',
        model: 'p0/m0',
      },
    })
  })

  it('treats a whitespace dsh home as unset', async () => {
    const { kernel } = await setup({ dshHome: '   ' })
    const reply = await kernel.handlers['rlm.run']!(
      { event: 'host_request', id: '1', data: { type: 'rlm.run', prompt: 'x', kwargs: { name: 'alpha' } } },
      { agent: agent('parent-1', { provider: 'p0', model: 'm0' }), signal: new AbortController().signal },
    )
    expect(reply.status).toBe('ok')
    if (reply.status !== 'ok') throw new Error('expected an ok reply')
    const dir = (reply.result as { session_dir: string }).session_dir
    expect(dir).toBe(join(resolveDshHome(), 'rlm', 'children', 'kid-1'))
  })
})
