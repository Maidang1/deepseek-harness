import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { HarnessRefiner, harnessScopes } from '../src/index.ts'
import type { HarnessEntry, HarnessRefinementProposal, HarnessScopeRef, HarnessState } from '../src/types.ts'

const AGENT_ID = brandString<SessionId>('session-1')

describe('harnessScopes', () => {
  it('names the session scope before the global one', () => {
    expect(harnessScopes()).toEqual(['local', 'global'])
  })
})

describe('HarnessRefiner', () => {
  it('registers one provider under the seam key and delegates every operation', async () => {
    class StubRefiner extends HarnessRefiner {
      read = (_scope?: HarnessScopeRef): Promise<HarnessState> => Promise.reject(new Error('read unreachable'))
      refine = (_proposal: HarnessRefinementProposal): Promise<never> => Promise.reject(new Error('refine unreachable'))
      rollback = (_eventId: string): Promise<number> => Promise.resolve(0)
      writeEntry = (): Promise<HarnessEntry> => Promise.reject(new Error('writeEntry unreachable'))
      list = (): Promise<readonly HarnessEntry[]> => Promise.resolve([])
    }
    const ctx = new Context()
    await ctx.plugin(StubRefiner)
    const refiner = ctx.get('rlmHarness') as StubRefiner
    await expect(refiner.read({ sessionId: AGENT_ID })).rejects.toThrow('read unreachable')
    await expect(refiner.rollback('e1')).resolves.toBe(0)
    await expect(refiner.list()).resolves.toEqual([])
    await ctx.fiber.dispose()
  })
})
