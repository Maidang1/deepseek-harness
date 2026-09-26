import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { RlmKernelError } from '../src/index.ts'
import { RlmKernel } from '../src/index.ts'
import type { RlmKernelHandle, RlmKernelAcquireOptions } from '../src/types.ts'

const AGENT = { id: brandString<SessionId>('session-1') } as Agent

describe('RlmKernelError', () => {
  it('names itself and keeps its cause', () => {
    const cause = new Error('child died')
    const error = new RlmKernelError('kernel lost', { cause })
    expect(error.name).toBe('RlmKernelError')
    expect(error.message).toBe('kernel lost')
    expect(error.cause).toBe(cause)
  })
})

describe('RlmKernel', () => {
  it('registers the provider under the seam key and delegates both operations', async () => {
    const handle = {} as RlmKernelHandle
    const acquire = vi.fn((_agent: Agent, _options?: RlmKernelAcquireOptions) => Promise.resolve(handle))
    const release = vi.fn((_sessionId: SessionId) => Promise.resolve())
    class StubProvider extends RlmKernel {
      acquire = acquire
      release = release
    }
    const ctx = new Context()
    const provider = new StubProvider(ctx)
    await expect(provider.acquire(AGENT, { pythonPath: ['/pkg/py'] })).resolves.toBe(handle)
    expect(acquire).toHaveBeenCalledWith(AGENT, { pythonPath: ['/pkg/py'] })
    await provider.release(AGENT.id)
    expect(release).toHaveBeenCalledWith('session-1')
  })
})
