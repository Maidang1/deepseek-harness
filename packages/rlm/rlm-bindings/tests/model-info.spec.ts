import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { RlmHostRequestContext, RlmHostRequestEvent } from '@deepseek-ai/dsh-rlm-kernel'
import { createModelInfoHostHandlers } from '../src/model-info.ts'
import type { ModelInfoCatalog } from '../src/model-info.ts'

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

function request(data: RlmHostRequestEvent['data']): RlmHostRequestEvent {
  return { event: 'host_request', id: '1', data }
}

function contextFor(owner: Agent, signal = new AbortController().signal): RlmHostRequestContext {
  return { agent: owner, signal }
}

class FakeModels implements ModelInfoCatalog {
  readonly calls: { provider: string; model: string; signal: AbortSignal | undefined }[] = []
  modalities: readonly string[] | undefined = ['text', 'image']
  failure: Error | undefined

  resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ inputModalities?: readonly string[] }> {
    this.calls.push({ provider, model, signal })
    if (this.failure !== undefined) return Promise.reject(this.failure)
    return Promise.resolve(this.modalities === undefined ? {} : { inputModalities: this.modalities })
  }
}

describe('model.info', () => {
  it('returns the calling agent route and its resolved modalities', async () => {
    const models = new FakeModels()
    const handlers = createModelInfoHostHandlers({ models })
    const owner = agent('s1', { provider: 'p1', model: 'm1' })
    const signal = new AbortController().signal
    const reply = await handlers['model.info']!(request({ type: 'model.info' }), { agent: owner, signal })
    expect(reply).toEqual({
      status: 'ok',
      result: { id: 'm1', provider: 'p1', input: ['text', 'image'] },
    })
    expect(models.calls).toEqual([{ provider: 'p1', model: 'm1', signal }])
  })

  it('returns an empty input list when the route declares no modalities', async () => {
    const models = new FakeModels()
    models.modalities = undefined
    const handlers = createModelInfoHostHandlers({ models })
    const owner = agent('s1', { provider: 'p1', model: 'm1' })
    const reply = await handlers['model.info']!(request({ type: 'model.info' }), contextFor(owner))
    expect(reply).toEqual({ status: 'ok', result: { id: 'm1', provider: 'p1', input: [] } })
  })

  it('degrades to an empty input list when the route cannot be resolved', async () => {
    const models = new FakeModels()
    models.failure = new Error('unknown provider')
    const handlers = createModelInfoHostHandlers({ models })
    const owner = agent('s1', { provider: 'p1', model: 'm1' })
    const reply = await handlers['model.info']!(request({ type: 'model.info' }), contextFor(owner))
    expect(reply).toEqual({ status: 'ok', result: { id: 'm1', provider: 'p1', input: [] } })
  })

  it('returns null route fields when the agent has no model route', async () => {
    const models = new FakeModels()
    const handlers = createModelInfoHostHandlers({ models })
    const reply = await handlers['model.info']!(request({ type: 'model.info' }), contextFor(agent('s1')))
    expect(reply).toEqual({ status: 'ok', result: { id: null, provider: null, input: [] } })
    expect(models.calls).toHaveLength(0)
  })

  it('returns the partial route when only the provider is set', async () => {
    const models = new FakeModels()
    const handlers = createModelInfoHostHandlers({ models })
    const reply = await handlers['model.info']!(
      request({ type: 'model.info' }),
      contextFor(agent('s1', { provider: 'p1' })),
    )
    expect(reply).toEqual({ status: 'ok', result: { id: null, provider: 'p1', input: [] } })
  })

  it('returns the partial route when only the model is set', async () => {
    const models = new FakeModels()
    const handlers = createModelInfoHostHandlers({ models })
    const reply = await handlers['model.info']!(
      request({ type: 'model.info' }),
      contextFor(agent('s1', { model: 'm1' })),
    )
    expect(reply).toEqual({ status: 'ok', result: { id: 'm1', provider: null, input: [] } })
  })
})
