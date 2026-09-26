import { describe, expect, it } from 'vitest'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { findRlmModels } from '../src/models.ts'
import type { ModelCatalog } from '../src/models.ts'

function model(provider: string, id: string, name = ''): LlmModelInfo {
  return { provider, id, name }
}

const catalog: ModelCatalog = {
  listProviders: () => [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }],
  listModels: provider => Promise.resolve(
    provider === 'alpha'
      ? [model('alpha', 'chat-large', 'Chat Large'), model('alpha', 'chat-small', 'Chat Small')]
      : [model('beta', 'chat-large', 'Chat Large'), model('beta', 'reasoner')],
  ),
}

describe('findRlmModels', () => {
  it('searches every provider and ranks exact matches first', async () => {
    const matches = await findRlmModels(catalog, 'beta/reasoner', 8)
    expect(matches[0]).toEqual({ provider: 'beta', id: 'reasoner', name: 'reasoner', selector: 'beta/reasoner' })
  })

  it('ranks prefix matches over substring matches and breaks ties by selector', async () => {
    const matches = await findRlmModels(catalog, 'chatlarge', 8)
    expect(matches.map(match => match.selector)).toEqual(['alpha/chat-large', 'beta/chat-large'])
    const partial = await findRlmModels(catalog, 'large', 8)
    expect(partial.map(match => match.selector)).toEqual(['alpha/chat-large', 'beta/chat-large'])
  })

  it('ranks prefix matches below exact matches', async () => {
    const matches = await findRlmModels(catalog, 'chat', 8)
    expect(matches.map(match => match.selector)).toEqual(['alpha/chat-large', 'alpha/chat-small', 'beta/chat-large'])
  })

  it('matches against ids and names alike', async () => {
    const byName = await findRlmModels(catalog, 'Chat Small', 8)
    expect(byName.map(match => match.selector)).toEqual(['alpha/chat-small'])
  })

  it('returns an unranked slice for an empty query and drops non-matches', async () => {
    const all = await findRlmModels(catalog, '   ', 2)
    expect(all).toHaveLength(2)
    expect(await findRlmModels(catalog, 'no-such-model', 8)).toEqual([])
  })

  it('tolerates a catalog with no providers', async () => {
    const empty: ModelCatalog = { listProviders: () => [], listModels: () => Promise.resolve([]) }
    expect(await findRlmModels(empty, 'x', 8)).toEqual([])
  })
})
