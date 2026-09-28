import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, Inbox } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { RlmHostReplyData, RlmHostRequestContext, RlmHostRequestEvent } from '@deepseek-ai/dsh-rlm-kernel'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { createGoalHostHandlers } from '../src/goal.ts'
import type { GoalBackend, GoalBindingDeps, GoalPhase, GoalRef, GoalView } from '../src/goal.ts'

function agent(id: string, inbox: Inbox = unsupportedInbox()): Agent {
  const session = Session.create(SessionId(id), [], {
    version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 0, cwd: '/repo', isSeeded: false,
  })
  return {
    id: SessionId(id),
    options: {},
    session,
    inbox,
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

/** Unwrap an ok reply, failing the test on an error reply. */
function okResult(reply: RlmHostReplyData): JsonValue {
  if (reply.status !== 'ok') throw new Error('expected an ok reply')
  return reply.result
}

/** Invoke a handler so a synchronous validation throw surfaces as a rejection. */
async function call(
  handler: (request: RlmHostRequestEvent, context: RlmHostRequestContext) => Promise<unknown>,
  req: RlmHostRequestEvent,
  ctx: RlmHostRequestContext,
): Promise<unknown> {
  return handler(req, ctx)
}

interface ViewOptions {
  readonly id?: string
  readonly revision?: number
  readonly objective?: string
  readonly phase?: GoalPhase
  readonly blockedCode?: string
  readonly maxGoalRounds?: number
  readonly roundsStarted?: number
  readonly createdAt?: number
  readonly updatedAt?: number
}

function goalView(options: ViewOptions = {}): GoalView {
  const phase = options.phase ?? 'active'
  return {
    id: options.id ?? 'goal-1',
    revision: options.revision ?? 1,
    objective: options.objective ?? 'ship it',
    phase,
    ...phase === 'blocked' && options.blockedCode !== undefined
      ? { blockedReason: { code: options.blockedCode, message: 'blocked' } }
      : {},
    maxGoalRounds: options.maxGoalRounds ?? 256,
    roundsStarted: options.roundsStarted ?? 0,
    createdAt: options.createdAt ?? 1000,
    updatedAt: options.updatedAt ?? 2000,
  }
}

class FakeGoals implements GoalBackend {
  current: GoalView | undefined
  readonly created: { readonly agent: Agent; readonly objective: string }[] = []
  readonly completed: GoalRef[] = []
  completeResult: GoalView | undefined

  get(_agent: Agent): GoalView | undefined {
    return this.current
  }

  create(agent: Agent, request: { readonly objective: string }): GoalView {
    this.created.push({ agent, objective: request.objective })
    const view = goalView({ objective: request.objective })
    this.current = view
    return view
  }

  complete(_agent: Agent, ref: GoalRef): GoalView {
    this.completed.push(ref)
    const view = this.completeResult ?? goalView({ phase: 'complete' })
    this.current = view
    return view
  }
}

function deps(goals: GoalBackend): GoalBindingDeps {
  return { goals }
}

const ACTIVE_CONFLICT = 'cannot create a new goal because this thread already has an active goal;'
  + ' run `await goal.complete()` when it is achieved, or ask the user to clear it with /goal clear'
const PAUSED_CONFLICT = 'cannot create a new goal because a paused goal exists;'
  + ' ask the user to resume it with /goal resume or clear it with /goal clear'
const BUDGET_CONFLICT = 'cannot create a new goal because a budget-limited goal exists;'
  + ' ask the user to resume it with /goal resume or clear it with /goal clear'

describe('goal.get', () => {
  it('returns the empty reply when no goal exists', async () => {
    const handlers = createGoalHostHandlers(deps(new FakeGoals()))
    const reply = await handlers['goal.get']!(request({ type: 'goal.get' }), contextFor(agent('p')))
    expect(reply).toEqual({
      status: 'ok',
      result: { goal: null, remaining_tokens: null, completion_budget_report: null },
    })
  })

  it('serializes the current active goal', async () => {
    const goals = new FakeGoals()
    goals.current = goalView({ id: 'goal-9', roundsStarted: 3, maxGoalRounds: 10 })
    const handlers = createGoalHostHandlers(deps(goals))
    const reply = await handlers['goal.get']!(request({ type: 'goal.get' }), contextFor(agent('p')))
    const result = okResult(reply) as { goal: Record<string, unknown>; remaining_tokens: unknown; completion_budget_report: unknown }
    expect(result.goal).toEqual({
      goal_id: 'goal-9',
      objective: 'ship it',
      status: 'active',
      tokens_used: 0,
      time_used_seconds: 0,
      created_at: 1000,
      updated_at: 2000,
    })
    expect('token_budget' in result.goal).toBe(false)
    expect(result.remaining_tokens).toBeNull()
    expect(result.completion_budget_report).toBeNull()
  })

  it('maps a round-limit blocked goal to budget_limited', async () => {
    const goals = new FakeGoals()
    goals.current = goalView({ phase: 'blocked', blockedCode: 'round-limit' })
    const handlers = createGoalHostHandlers(deps(goals))
    const reply = await handlers['goal.get']!(request({ type: 'goal.get' }), contextFor(agent('p')))
    const result = okResult(reply) as { goal: { status: string } }
    expect(result.goal.status).toBe('budget_limited')
  })

  it('maps a policy-blocked goal to paused', async () => {
    const goals = new FakeGoals()
    goals.current = goalView({ phase: 'blocked', blockedCode: 'needs-input' })
    const handlers = createGoalHostHandlers(deps(goals))
    const reply = await handlers['goal.get']!(request({ type: 'goal.get' }), contextFor(agent('p')))
    const result = okResult(reply) as { goal: { status: string } }
    expect(result.goal.status).toBe('paused')
  })

  it('reports a completed goal without a completion report', async () => {
    const goals = new FakeGoals()
    goals.current = goalView({ phase: 'complete' })
    const handlers = createGoalHostHandlers(deps(goals))
    const reply = await handlers['goal.get']!(request({ type: 'goal.get' }), contextFor(agent('p')))
    const result = okResult(reply) as { goal: { status: string }; completion_budget_report: unknown }
    expect(result.goal.status).toBe('complete')
    expect(result.completion_budget_report).toBeNull()
  })

  it('reports a paused goal as paused', async () => {
    const goals = new FakeGoals()
    goals.current = goalView({ phase: 'paused' })
    const handlers = createGoalHostHandlers(deps(goals))
    const reply = await handlers['goal.get']!(request({ type: 'goal.get' }), contextFor(agent('p')))
    const result = okResult(reply) as { goal: { status: string } }
    expect(result.goal.status).toBe('paused')
  })
})

describe('goal.create', () => {
  it('creates a goal when none exists', async () => {
    const goals = new FakeGoals()
    const owner = agent('p')
    const handlers = createGoalHostHandlers(deps(goals))
    const reply = await handlers['goal.create']!(
      request({ type: 'goal.create', objective: '  ship it  ' }),
      contextFor(owner),
    )
    expect(goals.created).toEqual([{ agent: owner, objective: 'ship it' }])
    const result = okResult(reply) as { goal: { objective: string; status: string } }
    expect(result.goal.objective).toBe('ship it')
    expect(result.goal.status).toBe('active')
  })

  it('replaces a completed goal', async () => {
    const goals = new FakeGoals()
    goals.current = goalView({ phase: 'complete' })
    const handlers = createGoalHostHandlers(deps(goals))
    const reply = await handlers['goal.create']!(
      request({ type: 'goal.create', objective: 'next goal' }),
      contextFor(agent('p')),
    )
    expect(goals.created).toHaveLength(1)
    expect(reply.status).toBe('ok')
  })

  it('accepts a valid token budget without enforcing it', async () => {
    const goals = new FakeGoals()
    const owner = agent('p')
    const handlers = createGoalHostHandlers(deps(goals))
    const reply = await handlers['goal.create']!(
      request({ type: 'goal.create', objective: 'ship it', token_budget: 100000 }),
      contextFor(owner),
    )
    expect(reply.status).toBe('ok')
    expect(goals.created).toEqual([{ agent: owner, objective: 'ship it' }])
  })

  it('rejects a non-string objective', async () => {
    const handlers = createGoalHostHandlers(deps(new FakeGoals()))
    await expect(
      call(handlers['goal.create']!, request({ type: 'goal.create', objective: 42 }), contextFor(agent('p'))),
    ).rejects.toThrow('goal.create objective must be a string')
  })

  it('rejects a non-number token budget', async () => {
    const handlers = createGoalHostHandlers(deps(new FakeGoals()))
    await expect(
      call(handlers['goal.create']!, request({ type: 'goal.create', objective: 'x', token_budget: '1000' }), contextFor(agent('p'))),
    ).rejects.toThrow('goal.create token_budget must be an integer when provided')
  })

  it('rejects a non-positive or non-integer token budget', async () => {
    const handlers = createGoalHostHandlers(deps(new FakeGoals()))
    for (const tokenBudget of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        call(handlers['goal.create']!, request({ type: 'goal.create', objective: 'x', token_budget: tokenBudget }), contextFor(agent('p'))),
      ).rejects.toThrow('Goal token budget must be a positive integer.')
    }
  })

  it('rejects an empty objective', async () => {
    const handlers = createGoalHostHandlers(deps(new FakeGoals()))
    await expect(
      call(handlers['goal.create']!, request({ type: 'goal.create', objective: '   ' }), contextFor(agent('p'))),
    ).rejects.toThrow('Goal objective must not be empty.')
  })

  it('rejects an over-long objective', async () => {
    const handlers = createGoalHostHandlers(deps(new FakeGoals()))
    await expect(
      call(handlers['goal.create']!, request({ type: 'goal.create', objective: 'a'.repeat(4001) }), contextFor(agent('p'))),
    ).rejects.toThrow('Goal objective must be at most 4000 characters.')
  })

  it('rejects while an active goal is pending', async () => {
    const goals = new FakeGoals()
    goals.current = goalView({ phase: 'active' })
    const handlers = createGoalHostHandlers(deps(goals))
    await expect(
      call(handlers['goal.create']!, request({ type: 'goal.create', objective: 'x' }), contextFor(agent('p'))),
    ).rejects.toThrow(ACTIVE_CONFLICT)
    expect(goals.created).toHaveLength(0)
  })

  it('rejects while a paused goal is pending', async () => {
    const goals = new FakeGoals()
    goals.current = goalView({ phase: 'paused' })
    const handlers = createGoalHostHandlers(deps(goals))
    await expect(
      call(handlers['goal.create']!, request({ type: 'goal.create', objective: 'x' }), contextFor(agent('p'))),
    ).rejects.toThrow(PAUSED_CONFLICT)
  })

  it('rejects while a round-limited goal is pending', async () => {
    const goals = new FakeGoals()
    goals.current = goalView({ phase: 'blocked', blockedCode: 'round-limit' })
    const handlers = createGoalHostHandlers(deps(goals))
    await expect(
      call(handlers['goal.create']!, request({ type: 'goal.create', objective: 'x' }), contextFor(agent('p'))),
    ).rejects.toThrow(BUDGET_CONFLICT)
  })

  it('rejects while a policy-blocked goal is pending', async () => {
    const goals = new FakeGoals()
    goals.current = goalView({ phase: 'blocked', blockedCode: 'needs-input' })
    const handlers = createGoalHostHandlers(deps(goals))
    await expect(
      call(handlers['goal.create']!, request({ type: 'goal.create', objective: 'x' }), contextFor(agent('p'))),
    ).rejects.toThrow(PAUSED_CONFLICT)
  })

  it('checks conflicts before objective content', async () => {
    const goals = new FakeGoals()
    goals.current = goalView({ phase: 'active' })
    const handlers = createGoalHostHandlers(deps(goals))
    await expect(
      call(handlers['goal.create']!, request({ type: 'goal.create', objective: '   ' }), contextFor(agent('p'))),
    ).rejects.toThrow(ACTIVE_CONFLICT)
  })
})

describe('goal.complete', () => {
  it('rejects when no goal exists', async () => {
    const handlers = createGoalHostHandlers(deps(new FakeGoals()))
    await expect(
      call(handlers['goal.complete']!, request({ type: 'goal.complete' }), contextFor(agent('p'))),
    ).rejects.toThrow('cannot complete goal because this thread has no goal')
  })

  it('completes the current goal and reports the round budget', async () => {
    const goals = new FakeGoals()
    goals.current = goalView({ id: 'goal-7', revision: 4 })
    goals.completeResult = goalView({ id: 'goal-7', revision: 5, phase: 'complete', roundsStarted: 3, maxGoalRounds: 256 })
    const handlers = createGoalHostHandlers(deps(goals))
    const reply = await handlers['goal.complete']!(request({ type: 'goal.complete' }), contextFor(agent('p')))
    expect(goals.completed).toEqual([{ id: 'goal-7', revision: 4 }])
    const result = okResult(reply) as { goal: { status: string }; completion_budget_report: string }
    expect(result.goal.status).toBe('complete')
    expect(result.completion_budget_report).toBe(
      'Goal achieved. Report final budget usage to the user: goal rounds used: 3 of 256.',
    )
  })

  it('completes a paused goal', async () => {
    const goals = new FakeGoals()
    goals.current = goalView({ phase: 'paused' })
    const handlers = createGoalHostHandlers(deps(goals))
    const reply = await handlers['goal.complete']!(request({ type: 'goal.complete' }), contextFor(agent('p')))
    expect(goals.completed).toHaveLength(1)
    const result = okResult(reply) as { goal: { status: string } }
    expect(result.goal.status).toBe('complete')
  })

  it('answers an already-complete goal without a new transition', async () => {
    const goals = new FakeGoals()
    goals.current = goalView({ phase: 'complete', roundsStarted: 2, maxGoalRounds: 8 })
    const handlers = createGoalHostHandlers(deps(goals))
    const reply = await handlers['goal.complete']!(request({ type: 'goal.complete' }), contextFor(agent('p')))
    expect(goals.completed).toHaveLength(0)
    const result = okResult(reply) as { goal: { status: string }; completion_budget_report: string }
    expect(result.goal.status).toBe('complete')
    expect(result.completion_budget_report).toBe(
      'Goal achieved. Report final budget usage to the user: goal rounds used: 2 of 8.',
    )
  })

  it('omits the report when the backend view is not complete', async () => {
    const goals = new FakeGoals()
    goals.current = goalView({ phase: 'active' })
    goals.completeResult = goalView({ phase: 'paused' })
    const handlers = createGoalHostHandlers(deps(goals))
    const reply = await handlers['goal.complete']!(request({ type: 'goal.complete' }), contextFor(agent('p')))
    const result = okResult(reply) as { goal: { status: string }; completion_budget_report: unknown }
    expect(result.goal.status).toBe('paused')
    expect(result.completion_budget_report).toBeNull()
  })
})
