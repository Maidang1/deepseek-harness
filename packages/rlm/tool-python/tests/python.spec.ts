import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { RlmKernelError, RlmKernel } from '@deepseek-ai/dsh-rlm-kernel'
import type { RlmCellResult, RlmKernelHandle } from '@deepseek-ai/dsh-rlm-kernel'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.ts'

const SIGNAL = new AbortController().signal

function agent(id: string): Agent {
  const session = Session.create(SessionId(id), [], {
    version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 0, cwd: '/repo', isSeeded: false,
  })
  return {
    id: SessionId(id),
    options: {},
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

function cellResult(overrides: Partial<RlmCellResult> = {}): RlmCellResult {
  return { status: 'ok', stdout: 'out\n', stderr: '', display: [], durationMs: 5, ...overrides }
}

function handle(execute: (code: string, options?: { signal?: AbortSignal }) => Promise<RlmCellResult>): RlmKernelHandle {
  return {
    sessionId: SessionId('a'),
    execute,
    interrupt: () => {},
    snapshot: () => Promise.resolve({ saved: [], skipped: [], pruned: [], bytes: 0 }),
    restore: () => Promise.resolve({ restored: [], failed: [] }),
    listNames: () => Promise.resolve([]),
    dispose: () => Promise.resolve(),
  }
}

async function setup(config: Parameters<typeof apply>[1], handle: RlmKernelHandle): Promise<Context> {
  const acquire = (): Promise<RlmKernelHandle> => Promise.resolve(handle)
  class StubKernel extends RlmKernel {
    acquire = acquire
    release = () => Promise.resolve()
  }
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(StubKernel)
  apply(ctx, config)
  return ctx
}

function run(ctx: Context, code: string, scope: { readonly agent?: Agent } = { agent: agent('a') }) {
  return ctx.tools.execute({ signal: SIGNAL, callId: ToolCallId('c1'), name: 'python', arguments: { code }, ...scope })
}

describe('python tool', () => {
  it('forwards the cell to the session kernel', async () => {
    const execute = (code: string, options?: { signal?: AbortSignal }): Promise<RlmCellResult> => {
      expect(code).toBe('1+1')
      expect(options?.signal).toBe(SIGNAL)
      return Promise.resolve(cellResult({ representation: '2' }))
    }
    const handle: RlmKernelHandle = { sessionId: SessionId('a'), execute, interrupt: () => {}, snapshot: () => Promise.resolve({ saved: [], skipped: [], pruned: [], bytes: 0 }), restore: () => Promise.resolve({ restored: [], failed: [] }), listNames: () => Promise.resolve([]), dispose: () => Promise.resolve() }
    const ctx = await setup({}, handle)
    const result = await run(ctx, '1+1')
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toContain('out')
    expect(JSON.stringify(result.content)).toContain('2')
  })

  it('rejects a cell over the configured ceiling', async () => {
    const ctx = await setup({ maxCodeChars: 4 }, {} as RlmKernelHandle)
    const result = await run(ctx, '12345')
    expect(result.isError).toBe(true)
    expect(result.error?.message).toContain('over the 4 limit')
  })

  it('names a non-kernel failure as a kernel failure', async () => {
    const kernel = handle(() => Promise.reject(new Error('boom')))
    const ctx = await setup({}, kernel)
    const result = await run(ctx, '1')
    expect(result.isError).toBe(true)
    expect(result.error?.message).toContain('kernel failed: boom')
  })

  it('passes a kernel failure through unchanged', async () => {
    const kernel = handle(() => Promise.reject(new RlmKernelError('kernel lost')))
    const ctx = await setup({}, kernel)
    const result = await run(ctx, '1')
    expect(result.isError).toBe(true)
    expect(result.error?.message).toBe('kernel lost')
  })

  it('rejects a non-positive ceiling at load', () => {
    expect(() => { apply(new Context(), { maxCodeChars: 0 }) }).toThrow('tool-python: maxCodeChars must be positive')
  })

  it('reports a cell that raised', async () => {
    const failure = cellResult({
      status: 'error',
      stdout: '',
      error: { ename: 'ValueError', evalue: 'bad seed', traceback: ['cell()', 'raise ValueError("bad seed")'] },
    })
    const ctx = await setup({}, handle(() => Promise.resolve(failure)))
    const result = await run(ctx, 'boom()')
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([
      { type: 'text', text: 'bad seed\ncell()\nraise ValueError("bad seed")' },
    ])
  })

  it('reports a silent cell with no representation', async () => {
    const ctx = await setup({}, handle(() => Promise.resolve(cellResult({ stdout: '' }))))
    const result = await run(ctx, 'x = 1')
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([])
  })

  it('stringifies a non-Error kernel failure', async () => {
    // A kernel may reject with anything; the tool stringifies non-Error reasons.
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors
    const ctx = await setup({}, handle(() => Promise.reject('lost the kernel')))
    const result = await run(ctx, '1')
    expect(result.isError).toBe(true)
    expect(result.error?.message).toBe('python: kernel failed: lost the kernel')
  })

  it('refuses a call that arrives without an agent session', async () => {
    const ctx = await setup({}, handle(() => Promise.resolve(cellResult())))
    const result = await run(ctx, '1+1', {})
    expect(result.isError).toBe(true)
    expect(result.error?.message).toBe('python: this tool requires an agent session')
  })
})

describe('python tool presentation', () => {
  it('renders only the channels a cell produced', async () => {
    const ctx = await setup({}, handle(() => Promise.resolve(cellResult())))
    expect(ctx.tools.get('python')!.output.render({ code: 'x' }, { status: 'ok', stdout: 'o\n', stderr: 'warn\n', representation: '7', durationMs: 3 }))
      .toEqual([
        { type: 'text', text: 'o\n' },
        { type: 'text', text: 'warn\n' },
        { type: 'text', text: '7' },
      ])
    expect(ctx.tools.get('python')!.output.render({ code: 'x' }, { status: 'ok', stdout: '', stderr: '', durationMs: 3 })).toEqual([])
  })

  it('renders an uncaught error after the channels it preceded', async () => {
    const ctx = await setup({}, handle(() => Promise.resolve(cellResult())))
    const value = {
      status: 'error',
      stdout: '',
      stderr: 'warn\n',
      error: { ename: 'ValueError', evalue: 'bad seed', traceback: ['cell()', 'raise ValueError("bad seed")'] },
      durationMs: 4,
    }
    expect(ctx.tools.get('python')!.output.render({ code: 'x' }, value)).toEqual([
      { type: 'text', text: 'warn\n' },
      { type: 'text', text: 'bad seed\ncell()\nraise ValueError("bad seed")' },
    ])
  })

  it('projects the presentation metadata a host card summarizes', async () => {
    const ctx = await setup({}, handle(() => Promise.resolve(cellResult({ stdout: 'abc', stderr: 'de', representation: '7' }))))
    const meta = ctx.tools.get('python')!.output.presentationMeta!({ code: 'x' }, { status: 'ok', stdout: 'abc', stderr: 'de', representation: '7', durationMs: 9 })
    expect(meta).toEqual({ status: 'ok', durationMs: 9, stdoutChars: 3, stderrChars: 2 })
  })

  it('labels the pending and settled call states', async () => {
    const ctx = await setup({}, handle(() => Promise.resolve(cellResult())))
    const present = ctx.tools.get('python')!
    expect(present.presentCall!({ code: 'x = 1' }))
      .toEqual({ card: 'generic', title: 'Run Python cell', kind: 'execute', rawInput: 'x = 1' })
    expect(present.presentResult!({ code: 'x' }, { content: [], isError: false }))
      .toEqual({ card: 'generic', title: 'Python cell' })
    expect(present.presentResult!({ code: 'x' }, { content: [{ type: 'text', text: 'bad' }], isError: true }))
      .toEqual({ card: 'generic', title: 'Python cell failed' })
  })
})
