/**
 * `rlm.find_models`: search the composition's advertised model catalog without
 * adding it to the system prompt. Scoring mirrors the reference host: exact
 * matches beat prefix matches beat substring matches, ties break by selector.
 *
 * @module @deepseek-ai/dsh-rlm-bindings/models
 */

import type { LlmModelInfo, LlmProviderInfo } from '@deepseek-ai/dsh-llm'

/** The slice of `ctx.llm` model discovery needs. */
export interface ModelCatalog {
  /** Every registered provider route. */
  listProviders(): LlmProviderInfo[]
  /** The advertised models of one provider route. */
  listModels(provider: string): Promise<readonly LlmModelInfo[]>
}

/** One model match carried back to the runtime. */
export type RlmModelMatch = {
  /** Provider route that owns the model. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly id: string
  /** Human-readable model name. */
  readonly name: string
  /** The `provider/model` selector a spawn request quotes. */
  readonly selector: string
}

/** Lowercase alphanumeric fold for search text. */
function normalizeModelSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * Score and rank the catalog matches of one query.
 *
 * @param query - the raw search text; an empty query ranks everything equally.
 * @param models - the catalog entries under test.
 * @param limit - the maximum number of matches returned.
 * @returns the best `limit` matches, best first.
 */
export function scoreRlmModelMatches(
  query: string,
  models: readonly LlmModelInfo[],
  limit: number,
): RlmModelMatch[] {
  const normalizedQuery = normalizeModelSearchText(query.trim())
  return models
    .map((model) => {
      const selector = `${model.provider}/${model.id}`
      const fields = [selector, model.id, model.name || model.id]
      const normalizedFields = fields.map(normalizeModelSearchText)
      let score = normalizedQuery.length > 0 ? Number.POSITIVE_INFINITY : 0
      if (normalizedQuery.length > 0) {
        const exactIndex = normalizedFields.indexOf(normalizedQuery)
        const prefixIndex = normalizedFields.findIndex(field => field.startsWith(normalizedQuery))
        const partialIndex = normalizedFields.findIndex(field => field.includes(normalizedQuery))
        if (exactIndex >= 0) score = exactIndex
        else if (prefixIndex >= 0) score = 3 + prefixIndex
        else if (partialIndex >= 0) score = 6 + partialIndex
      }
      return { model, selector, score }
    })
    .filter(candidate => Number.isFinite(candidate.score))
    .sort((a, b) => a.score - b.score || a.selector.localeCompare(b.selector))
    .slice(0, limit)
    .map(({ model, selector }) => ({
      provider: model.provider,
      id: model.id,
      name: model.name || model.id,
      selector,
    }))
}

/**
 * Search every registered provider's advertised models for one query.
 *
 * @param catalog - the model catalog to search.
 * @param query - the raw search text.
 * @param limit - the maximum number of matches returned.
 * @returns the best `limit` matches, best first.
 */
export async function findRlmModels(
  catalog: ModelCatalog,
  query: string,
  limit: number,
): Promise<RlmModelMatch[]> {
  const models: LlmModelInfo[] = []
  for (const provider of catalog.listProviders()) {
    models.push(...await catalog.listModels(provider.id))
  }
  return scoreRlmModelMatches(query, models, limit)
}
