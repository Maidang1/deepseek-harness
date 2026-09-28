import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { RlmHostRequestHandlers } from '@deepseek-ai/dsh-rlm-kernel'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { PythonRlmKernel } from '../src/index.ts'

const PYTHON = process.env.RLM_TEST_PYTHON ?? 'python3'

/** Durable source name carried by every agent-message receipt. */
const AGENT_MESSAGE_SOURCE = 'agent_message'

/** Absolute directory of the bundled `py/skills/` tree this package ships. */
function skillsSourceDir(): string {
  return fileURLToPath(new URL('../py/skills/', import.meta.url))
}

function agent(id: string): Agent {
  return { id: brandString<SessionId>(id) } as Agent
}

function okReply(result: JsonValue): { readonly status: 'ok'; readonly result: JsonValue } {
  return { status: 'ok', result }
}

async function kernel(): Promise<PythonRlmKernel> {
  const ctx = new Context()
  await ctx.plugin(PythonRlmKernel, { pythonBin: PYTHON, pythonPath: [skillsSourceDir()] })
  return ctx.get('rlmKernel') as PythonRlmKernel
}

describe('bundled RLM skill packages', () => {
  it('imports all six skill packages from py/skills over pythonPath', async () => {
    const service = await kernel()
    const handle = await service.acquire(agent('skills-import'))
    const cell = await handle.execute(
      'import goal, compact, refine, rlm_heartbeat, agent_message, agent_observe\n'
      + 'print(goal.__name__, compact.__name__, refine.__name__, '
      + 'rlm_heartbeat.__name__, agent_message.__name__, agent_observe.__name__)',
    )
    expect(cell.status).toBe('ok')
    expect(cell.stdout).toContain('goal compact refine rlm_heartbeat agent_message agent_observe')
    await service.release('skills-import' as SessionId)
  })

  it('runs each skill\'s client-side validation without any host handler', async () => {
    const service = await kernel()
    const handle = await service.acquire(agent('skills-validation'))
    const cell = await handle.execute(`
import goal, compact, refine, rlm_heartbeat, agent_message, agent_observe

async def check():
    results = []
    for thunk, ename in [
        (lambda: goal.create(1), 'TypeError'),
        (lambda: compact.run(1), 'TypeError'),
        (lambda: refine.run(global_='x'), 'TypeError'),
        (lambda: rlm_heartbeat.create(1), 'TypeError'),
        (lambda: rlm_heartbeat.create('x', delivery_mode='bad'), 'ValueError'),
        (lambda: agent_observe.get_agent(1), 'TypeError'),
        (lambda: agent_observe.recent_messages('t', limit='x'), 'TypeError'),
        (lambda: agent_message.send('hi'), 'ValueError'),
        (lambda: agent_message.send('hi', receiver_role='parent', receiver_name='n'), 'ValueError'),
    ]:
        try:
            await thunk()
        except Exception as err:
            results.append(type(err).__name__)
        else:
            results.append('no-error')
    return results

print(await check())
`)
    expect(cell.status).toBe('ok')
    expect(cell.stdout).toContain(
      "['TypeError', 'TypeError', 'TypeError', 'TypeError', 'ValueError', 'TypeError', 'TypeError', 'ValueError', 'ValueError']",
    )
    await service.release('skills-validation' as SessionId)
  })

  it('round-trips goal.get and rlm_heartbeat.list through stub host handlers', async () => {
    const seen: string[] = []
    const hostRequests: RlmHostRequestHandlers = {
      'goal.get': () => {
        seen.push('goal.get')
        return Promise.resolve(okReply({ goal: null, remaining_tokens: null, completion_budget_report: null }))
      },
      'rlm_heartbeat.list': (request) => {
        seen.push(`rlm_heartbeat.list:${JSON.stringify(request.data['include_inactive'])}`)
        return Promise.resolve(okReply({ heartbeats: [] }))
      },
    }
    const service = await kernel()
    const handle = await service.acquire(agent('skills-wire'), { hostRequests })
    const cell = await handle.execute(`
import goal, rlm_heartbeat
g = await goal.get()
h = await rlm_heartbeat.list(include_inactive=True)
print(sorted(g), g['goal'])
print(h['heartbeats'])
`)
    expect(cell.status).toBe('ok')
    expect(cell.stdout).toContain("['completion_budget_report', 'goal', 'remaining_tokens'] None")
    expect(cell.stdout).toContain('[]')
    expect(seen).toEqual(['goal.get', 'rlm_heartbeat.list:true'])
    await service.release('skills-wire' as SessionId)
  })

  it('sends an agent_message through a stub host and emits the receipt display', async () => {
    const hostRequests: RlmHostRequestHandlers = {
      'agent_message.send': request =>
        Promise.resolve(okReply({
          id: 'agentmsg_stub',
          source: AGENT_MESSAGE_SOURCE,
          deliveryStatus: 'delivered',
          receiverRole: request.data['receiver_role'] ?? null,
        })),
    }
    const service = await kernel()
    const handle = await service.acquire(agent('skills-message'), { hostRequests })
    const displays: unknown[] = []
    const cell = await handle.execute(
      `import agent_message
receipt = await agent_message.send('hello parent', receiver_role='parent')
print(receipt['deliveryStatus'])`,
      { onEvent: (event) => { if (event.event === 'display') displays.push(event.data) } },
    )
    expect(cell.status).toBe('ok')
    expect(cell.stdout).toContain('delivered')
    expect(displays).toHaveLength(1)
    const data = displays[0] as Record<string, unknown>
    expect(data['text/plain']).toBe('Agent message sent')
    const mime = data['application/vnd.prime-agent.agent-message+json'] as Record<string, unknown>
    expect(mime['deliveryStatus']).toBe('delivered')
    await service.release('skills-message' as SessionId)
  })

  it('surfaces the host error for a wire with no registered handler', async () => {
    const service = await kernel()
    const handle = await service.acquire(agent('skills-unhandled'))
    const cell = await handle.execute(`
import compact
try:
    await compact.status()
except RuntimeError as err:
    print(type(err).__name__, str(err)[:60])
`)
    expect(cell.status).toBe('ok')
    expect(cell.stdout).toContain('RuntimeError')
    await service.release('skills-unhandled' as SessionId)
  })
})
