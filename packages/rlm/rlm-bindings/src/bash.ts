/**
 * Background-command completion notices. A detached `bash()` job in the
 * runtime ends out of band, so the bindings steer a one-line notice into the
 * owning session — an idle driver starts a turn, a running one reads it at
 * the next step boundary. When the kernel reads the result first, the notice
 * is stale and is withdrawn from the inbox while it is still pending.
 *
 * @module @deepseek-ai/dsh-rlm-bindings/bash
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, MessageId, MessageSource, UserMessage } from '@deepseek-ai/dsh-llm'
import type { BashCompletion } from './read.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Background-command completion notices steered into the owning session. */
    'rlm-bindings': { kind: 'rlm-bindings' } & ContextFormed
  }
}

/** Producer source stamped on every completion notice. */
const BASH_NOTICE_SOURCE: MessageSource = { kind: 'rlm-bindings' }

/**
 * Format the model-facing text of one completion notice.
 *
 * @param details - the validated completion.
 * @returns the one-line header plus the quoted command.
 */
export function formatBashCompletionNotice(details: BashCompletion): string {
  return `[bash-done pid:${details.pid} exit:${details.exitCode}]\n\nCommand: ${JSON.stringify(details.command)}`
}

/**
 * Build the steered user message announcing one completion.
 *
 * @param details - the validated completion.
 * @returns the identified message to steer into the owning session.
 */
export function createBashCompletionMessage(details: BashCompletion): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: formatBashCompletionNotice(details) }],
    source: BASH_NOTICE_SOURCE,
  })
}

/**
 * Pending completion notices per session, oldest first. One `bash.consumed`
 * withdraws one notice: pids are reused across handles, and the read belongs
 * to the older handle, which is the earlier notice.
 */
export class BashNoticeBoard {
  private readonly pending = new Map<string, { pid: number; command: string; messageId: MessageId }[]>()

  /**
   * Record a steered notice so a later `bash.consumed` can withdraw it.
   *
   * @param agentId - the session the notice was steered into.
   * @param pid - process id of the finished command.
   * @param command - the command line that finished.
   * @param messageId - identity of the steered message.
   */
  record(agentId: string, pid: number, command: string, messageId: MessageId): void {
    let list = this.pending.get(agentId)
    if (list === undefined) {
      list = []
      this.pending.set(agentId, list)
    }
    list.push({ pid, command, messageId })
  }

  /**
   * Withdraw the earliest notice matching one consumed result.
   *
   * @param agentId - the session the notice was steered into.
   * @param pid - process id of the consumed command.
   * @param command - the command line that was read.
   * @returns the steered message's identity, or `undefined` when nothing pending matches.
   */
  takeEarliest(agentId: string, pid: number, command: string): MessageId | undefined {
    const list = this.pending.get(agentId)
    if (list === undefined) return undefined
    const notice = list.find(candidate => candidate.pid === pid && candidate.command === command)
    if (notice === undefined) return undefined
    list.splice(list.indexOf(notice), 1)
    if (list.length === 0) this.pending.delete(agentId)
    return notice.messageId
  }
}
