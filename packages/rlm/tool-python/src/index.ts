/**
 * Model-facing consumer of the `ctx.rlmKernel` seam: the `python` tool runs one
 * code cell in the session's persistent interpreter.
 *
 * The tool is a leaf over the kernel handle. It contributes the tool schema and
 * the result rendering, enforces the code-length ceiling the operator
 * configured, and forwards the execution's abort signal as a kernel interrupt.
 *
 * @module @deepseek-ai/dsh-tool-python
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { RlmKernelError } from '@deepseek-ai/dsh-rlm-kernel'

export const name = 'tool-python'
export const inject = ['rlmKernel', 'tools']

/** Default ceiling on the code one call may submit, in characters. */
const DEFAULT_MAX_CODE_CHARS = 100_000

/** Model-facing configuration for the `python` tool. */
export interface Config {
  /** Maximum number of characters one call's `code` may carry. */
  maxCodeChars?: number
}

/** Validated model-facing configuration for the `python` tool. */
export const Config: z<Config> = z.object({
  maxCodeChars: z.number().default(DEFAULT_MAX_CODE_CHARS),
})

/**
 * Register the `python` tool over the persistent kernel.
 *
 * A session's kernel starts on the session's first `python` call and survives
 * across turns, so a variable bound by one cell is visible to the next.
 *
 * @param ctx - the Cordis context this plugin registers into.
 * @param config - validated configuration with live budgets.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const maxCodeChars = config.maxCodeChars ?? DEFAULT_MAX_CODE_CHARS
  if (maxCodeChars <= 0) throw new Error('tool-python: maxCodeChars must be positive')

  ctx.tools.register(defineTool({
    name: 'python',
    description: 'Run one code cell in this session\'s persistent Python environment. '
      + 'Top-level await works, and every name a cell binds stays available to later cells. '
      + 'Use bash("command") inside a cell for a subprocess. Prefer this tool over scratch files '
      + 'for computation, data work, and anything whose intermediate state a later step needs.',
    parameters: {
      code: {
        type: 'string',
        required: true,
        description: 'The Python source of one cell. A trailing expression is returned as its repr.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          representation: { type: 'string' },
          error: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ename: { type: 'string', required: true },
              evalue: { type: 'string', required: true },
              traceback: { type: 'array', items: { type: 'string' }, required: true },
            },
          },
          durationMs: { type: 'integer', required: true },
        },
      },
      render: (_args, value): ContentBlock[] => {
        const blocks: ContentBlock[] = []
        if (value.stdout !== '') blocks.push({ type: 'text', text: value.stdout })
        if (value.stderr !== '') blocks.push({ type: 'text', text: value.stderr })
        if (value.representation !== undefined) blocks.push({ type: 'text', text: value.representation })
        if (value.error !== undefined) {
          blocks.push({ type: 'text', text: [value.error.evalue, ...value.error.traceback].join('\n') })
        }
        return blocks
      },
      presentationMeta: (_args, value) => ({
        status: value.status,
        durationMs: value.durationMs,
        stdoutChars: value.stdout.length,
        stderrChars: value.stderr.length,
      }),
    },
    async execute(args, exec) {
      if (args.code.length > maxCodeChars) {
        throw new Error(`python: code is ${String(args.code.length)} characters, over the ${String(maxCodeChars)} limit`)
      }
      const agent: Agent | undefined = exec.agent
      if (agent === undefined) throw new Error('python: this tool requires an agent session')
      const handle = await ctx.rlmKernel.acquire(agent)
      let cell
      try {
        cell = await handle.execute(args.code, { signal: exec.signal })
      } catch (error: unknown) {
        if (error instanceof RlmKernelError) throw error
        throw new RlmKernelError(`python: kernel failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      return {
        status: cell.status,
        stdout: cell.stdout,
        stderr: cell.stderr,
        ...cell.representation === undefined ? {} : { representation: cell.representation },
        ...cell.error === undefined ? {} : {
          error: { ename: cell.error.ename, evalue: cell.error.evalue, traceback: [...cell.error.traceback] },
        },
        durationMs: cell.durationMs,
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Run Python cell', kind: 'execute', rawInput: args.code }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'Python cell failed' : 'Python cell' }),
  }))
}
