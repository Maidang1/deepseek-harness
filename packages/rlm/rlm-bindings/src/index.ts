/**
 * Host bindings answering the RLM Python runtime's `host_request` types: child
 * spawning and fan-in through `ctx.subagents`, model search through `ctx.llm`,
 * and progress notes against a per-composition roster. The handlers mount on
 * `ctx.rlmKernel` once per composition and read the calling agent off each
 * request's context, so one registration serves every session's kernel.
 *
 * @module @deepseek-ai/dsh-rlm-bindings
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { BashNoticeBoard } from './bash.ts'
import { Roster } from './roster.ts'
import { createRlmHostHandlers } from './subagents.ts'

export const name = 'rlm-bindings'
export const inject = ['rlmKernel', 'subagents', 'llm', 'sessionQuery']

/** Plugin configuration for the RLM host bindings. */
export interface Config {
  /** Registry name of the continuable spawn provider children are created through. */
  providerName?: string
  /** DSH home directory override; empty resolves through `DSH_HOME` or `~/.dsh`. */
  dshHome?: string
}

/** Validated plugin configuration for the RLM host bindings. */
export const Config: z<Config> = z.object({
  providerName: z.string().default('spawn'),
  dshHome: z.string().default(''),
})

/**
 * Register the nine host-request handlers on the kernel service.
 *
 * The roster the handlers share lives for the composition's lifetime; the
 * registration itself is withdrawn when the plugin's fiber disposes.
 *
 * @param ctx - the Cordis context this plugin registers into.
 * @param config - validated configuration with the spawn provider name.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const providerName = config.providerName ?? 'spawn'
  const dshHome = config.dshHome === undefined || config.dshHome.trim().length === 0 ? undefined : config.dshHome
  const observations: SessionQueryEngine = ctx.sessionQuery
  const withdraw = ctx.rlmKernel.registerHostRequestHandlers(createRlmHostHandlers({
    subagents: ctx.subagents,
    models: ctx.llm,
    observations,
    roster: new Roster(),
    providerName,
    sessionDir: (childId: string): string => join(resolveDshHome(dshHome), 'rlm', 'children', childId),
    notices: new BashNoticeBoard(),
  }))
  ctx.effect(() => () => { withdraw() })
}
