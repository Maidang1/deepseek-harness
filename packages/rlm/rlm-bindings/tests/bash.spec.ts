import { describe, expect, it } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { BashNoticeBoard, createBashCompletionMessage, formatBashCompletionNotice } from '../src/bash.ts'

describe('formatBashCompletionNotice', () => {
  it('lays out the header line and the quoted command', () => {
    expect(formatBashCompletionNotice({ pid: 42, command: 'make test', exitCode: 1 }))
      .toBe('[bash-done pid:42 exit:1]\n\nCommand: "make test"')
  })
})

describe('createBashCompletionMessage', () => {
  it('builds an identified user message stamped with the bindings source', () => {
    const message = createBashCompletionMessage({ pid: 42, command: 'ls', exitCode: 0 })
    expect(message.role).toBe('user')
    expect(message.id).toBeDefined()
    expect(message.source).toEqual({ kind: 'rlm-bindings' })
    expect(message.content).toEqual([{ type: 'text', text: '[bash-done pid:42 exit:0]\n\nCommand: "ls"' }])
  })

  it('mints a fresh identity per message', () => {
    const first = createBashCompletionMessage({ pid: 1, command: 'a', exitCode: 0 })
    const second = createBashCompletionMessage({ pid: 1, command: 'a', exitCode: 0 })
    expect(first.id).not.toBe(second.id)
  })
})

describe('BashNoticeBoard', () => {
  it('withdraws the earliest matching notice', () => {
    const board = new BashNoticeBoard()
    board.record('s1', 7, 'ls', MessageId('m1'))
    board.record('s1', 7, 'ls', MessageId('m2'))
    expect(board.takeEarliest('s1', 7, 'ls')).toBe(MessageId('m1'))
    expect(board.takeEarliest('s1', 7, 'ls')).toBe(MessageId('m2'))
    expect(board.takeEarliest('s1', 7, 'ls')).toBeUndefined()
  })

  it('matches on pid and command together, per session', () => {
    const board = new BashNoticeBoard()
    board.record('s1', 7, 'ls', MessageId('m1'))
    expect(board.takeEarliest('s2', 7, 'ls')).toBeUndefined()
    expect(board.takeEarliest('s1', 8, 'ls')).toBeUndefined()
    expect(board.takeEarliest('s1', 7, 'pwd')).toBeUndefined()
    expect(board.takeEarliest('s1', 7, 'ls')).toBe(MessageId('m1'))
  })

  it('forgets a session once its last notice is withdrawn', () => {
    const board = new BashNoticeBoard()
    board.record('s1', 7, 'ls', MessageId('m1'))
    board.record('s1', 8, 'pwd', MessageId('m2'))
    expect(board.takeEarliest('s1', 7, 'ls')).toBe(MessageId('m1'))
    expect(board.takeEarliest('s1', 8, 'pwd')).toBe(MessageId('m2'))
    expect(board.takeEarliest('s1', 9, 'other')).toBeUndefined()
  })
})
