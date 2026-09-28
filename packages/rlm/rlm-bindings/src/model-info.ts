/**
 * Host handler for the `model.info` request: the calling agent's own route
 * and its accepted input modalities. The reference host reads these off the
 * live model object; here the route comes from the agent's options and the
 * modalities from `ctx.llm`'s adapter-resolved metadata, degrading to an
 * empty list when the route cannot be resolved.
 *
 * @module @deepseek-ai/dsh-rlm-bindings/model-info
 */

import type {
  RlmHostReplyData,
  RlmHostRequestContext,
  RlmHostRequestHandlers,
} from '@deepseek-ai/dsh-rlm-kernel'
import { ok } from './read.ts'

/** The slice of `ctx.llm` model.info resolves input modalities through. */
export interface ModelInfoCatalog {
  /**
   * Resolve adapter-owned metadata of one exact provider/model route.
   * @param provider - registered provider route to inspect.
   * @param model - exact model id on that route.
   * @param signal - optional cancellation for the adapter lookup.
   * @returns the route's metadata, with accepted modalities when known.
   */
  resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ readonly inputModalities?: readonly string[] }>
}

/** Everything the model.info host handler needs from the composition, captured at load. */
export interface ModelInfoDeps {
  /** The model catalog resolving the route's modalities. */
  readonly models: ModelInfoCatalog
}

/** The `model.info` reply payload: the calling agent's route and its input modalities. */
export type ModelInfo = {
  /** Model id of the calling agent's route, or null when the agent has none. */
  readonly id: string | null
  /** Provider route of the calling agent, or null when the agent has none. */
  readonly provider: string | null
  /** Accepted request modalities; empty when unknown or unresolvable. */
  readonly input: string[]
}

/** Read the calling agent's route, resolving modalities best-effort. */
async function modelInfo(deps: ModelInfoDeps, context: RlmHostRequestContext): Promise<ModelInfo> {
  const provider = context.agent.options.provider
  const model = context.agent.options.model
  if (provider === undefined || model === undefined) {
    return { id: model ?? null, provider: provider ?? null, input: [] }
  }
  let input: readonly string[] = []
  try {
    input = (await deps.models.resolveModelInfo(provider, model, context.signal)).inputModalities ?? []
  } catch {
    // The reference host reads modalities off the live model, which never
    // fails; an unresolvable route degrades to the same empty list it would
    // report for a model without declared modalities.
    input = []
  }
  return { id: model, provider, input: [...input] }
}

/**
 * Assemble the host handler answering `model.info`.
 *
 * @param deps - the composition services captured at load.
 * @returns the handler map to register on `ctx.rlmKernel`.
 */
export function createModelInfoHostHandlers(deps: ModelInfoDeps): RlmHostRequestHandlers {
  return {
    'model.info': async (_request, context): Promise<RlmHostReplyData> => ok(await modelInfo(deps, context)),
  }
}
