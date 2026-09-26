/**
 * Wire and handle vocabulary for the persistent Python REPL kernel capability
 * seam. The kernel speaks one newline-delimited JSON protocol over a child
 * process's stdin/stdout; every type here is the host-side name for one frame
 * of that protocol, or for the result the host returns to a consumer.
 *
 * @module @deepseek-ai/dsh-rlm-kernel/types
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Host-to-child request that runs one code cell. */
export interface RlmExecuteRequest {
  readonly type: 'execute'
  readonly id: string
  readonly code: string
}

/** Host-to-child request that raises `KeyboardInterrupt` inside a running cell. */
export interface RlmInterruptRequest {
  readonly type: 'interrupt'
  readonly id?: string
}

/** Success payload of a host reply. */
export interface RlmHostReplyOk {
  readonly status: 'ok'
  readonly result: JsonValue
}

/** Failure payload of a host reply. */
export interface RlmHostReplyError {
  readonly status: 'error'
  readonly error: string
}

/** Host-to-child answer to one `host_request` event. */
export type RlmHostReplyData = RlmHostReplyOk | RlmHostReplyError

/** Host-to-child request answering a `host_request` event. */
export interface RlmHostReplyRequest {
  readonly type: 'host_reply'
  readonly id: string
  readonly data: RlmHostReplyData
}

/** Host-to-child request serializing the user namespace with `dill`. */
export interface RlmSnapshotRequest {
  readonly type: 'snapshot'
  readonly id: string
  readonly path: string
  readonly manifest_path: string
  readonly max_bytes?: number
  readonly max_variable_bytes?: number
  readonly prune_oversized?: boolean
}

/** Host-to-child request reviving a previously written snapshot. */
export interface RlmRestoreRequest {
  readonly type: 'restore'
  readonly id: string
  readonly path: string
}

/** Host-to-child request listing the user-defined top-level names. */
export interface RlmListNamesRequest {
  readonly type: 'list_names'
  readonly id: string
}

/** Host-to-child request that stops the runtime after killing live child processes. */
export interface RlmShutdownRequest {
  readonly type: 'shutdown'
  readonly id?: string
}

/** Every request the host writes on the child's stdin. */
export type RlmWireRequest =
  | RlmExecuteRequest
  | RlmInterruptRequest
  | RlmHostReplyRequest
  | RlmSnapshotRequest
  | RlmRestoreRequest
  | RlmListNamesRequest
  | RlmShutdownRequest

/** The handshake the runtime emits once, before any other event. */
export interface RlmReadyEvent {
  readonly event: 'ready'
  readonly protocol: number
  readonly python: string
}

/** Captured console output. `id` is the owning cell, or `null` for unattributed bytes. */
export interface RlmOutputEvent {
  readonly event: 'stdout' | 'stderr'
  readonly id: string | null
  readonly text: string
}

/** `repr` of a cell's trailing expression. */
export interface RlmResultEvent {
  readonly event: 'result'
  readonly id: string
  readonly text: string
}

/** One MIME-keyed payload shipped verbatim from the runtime's display bridge. */
export interface RlmDisplayEvent {
  readonly event: 'display'
  readonly id: string | null
  readonly data: Readonly<Record<string, JsonValue>>
}

/** One typed request from runtime code to the host. */
export interface RlmHostRequestEvent {
  readonly event: 'host_request'
  readonly id: string
  /** The request payload; a validated frame always carries a JSON object. */
  readonly data: Readonly<Record<string, JsonValue>>
}

/** An exception raised while running a cell. */
export interface RlmErrorEvent {
  readonly event: 'error'
  readonly id: string | null
  readonly ename: string
  readonly evalue: string
  readonly traceback: readonly string[]
}

/** Terminal event of one id'd request; exactly one per request. */
export interface RlmDoneEvent {
  readonly event: 'done'
  readonly id: string
  readonly status: 'ok' | 'error'
  /** Failure classification of a snapshot or restore. */
  readonly reason?: string
  readonly saved?: readonly string[]
  readonly skipped?: readonly string[]
  readonly pruned?: readonly string[]
  readonly bytes?: number
  readonly restored?: readonly string[]
  readonly failed?: readonly string[]
  readonly names?: readonly string[]
}

/** Every event the runtime writes on its stdout. */
export type RlmWireEvent =
  | RlmReadyEvent
  | RlmOutputEvent
  | RlmResultEvent
  | RlmDisplayEvent
  | RlmHostRequestEvent
  | RlmErrorEvent
  | RlmDoneEvent

/** Context a host handler receives for one `host_request` event. */
export interface RlmHostRequestContext {
  /** Agent whose cell issued the request. */
  readonly agent: Agent
  /** Signal aborted when the owning handle is disposed. */
  readonly signal: AbortSignal
}

/** One host handler, resolving the reply payload the child receives. */
export type RlmHostRequestHandler = (
  request: RlmHostRequestEvent,
  context: RlmHostRequestContext,
) => Promise<RlmHostReplyData>

/** Handler map keyed by the `type` field of a `host_request` payload. */
export type RlmHostRequestHandlers = Readonly<Record<string, RlmHostRequestHandler>>

/** Options accepted when a consumer first asks for one session's kernel. */
export interface RlmKernelAcquireOptions {
  /** Handlers answering the runtime's host requests. */
  readonly hostRequests?: RlmHostRequestHandlers
  /** Extra directories added to the child interpreter's module search path. */
  readonly pythonPath?: readonly string[]
}

/** Options for one `execute` call. */
export interface RlmExecuteOptions {
  /** Aborting stops the running cell without killing the kernel. */
  readonly signal?: AbortSignal
  /** Called for every event the cell produced, in protocol order. */
  readonly onEvent?: (event: RlmWireEvent) => void
}

/** One cell's collected outcome. */
export interface RlmCellResult {
  /** `ok` when the cell ran to completion, `error` when it raised or was interrupted. */
  readonly status: 'ok' | 'error'
  /** Everything the cell wrote to `sys.stdout`, including unattributed bytes. */
  readonly stdout: string
  /** Everything the cell wrote to `sys.stderr`, including unattributed bytes. */
  readonly stderr: string
  /** `repr` of the cell's trailing expression, when it produced one. */
  readonly representation?: string
  /** Display payloads the cell emitted, with the cell or task id they rode on. */
  readonly display: readonly RlmDisplayEvent[]
  /** The exception, when the cell raised. */
  readonly error?: RlmCellError
  /** Wall-clock duration of the cell in milliseconds. */
  readonly durationMs: number
}

/** The exception one cell raised. */
export interface RlmCellError {
  readonly ename: string
  readonly evalue: string
  readonly traceback: readonly string[]
}

/** Outcome of one snapshot request. */
export interface RlmSnapshotResult {
  /** Names written to the snapshot payload. */
  readonly saved: readonly string[]
  /** Names skipped for the aggregate byte cap, kept in the namespace. */
  readonly skipped: readonly string[]
  /** Names deleted from the namespace for exceeding the per-variable cap. */
  readonly pruned: readonly string[]
  /** Payload size in bytes. */
  readonly bytes: number
}

/** Outcome of one restore request. */
export interface RlmRestoreResult {
  /** Names revived into the namespace. */
  readonly restored: readonly string[]
  /** Names whose payload could not be revived. */
  readonly failed: readonly string[]
  /** Why a restore produced no names, when it did not. */
  readonly reason?: string
}

/** Handle over one session's persistent kernel. */
export interface RlmKernelHandle {
  /** Session identity that owns this kernel. */
  readonly sessionId: SessionId
  /** Run one code cell in the persistent namespace. */
  execute(code: string, options?: RlmExecuteOptions): Promise<RlmCellResult>
  /** Raise `KeyboardInterrupt` in the running cell. */
  interrupt(): void
  /** Serialize the user namespace to `request.path`. */
  snapshot(request: Omit<RlmSnapshotRequest, 'type' | 'id'>): Promise<RlmSnapshotResult>
  /** Revive the snapshot previously written to `path`. */
  restore(path: string): Promise<RlmRestoreResult>
  /** Sorted user-defined top-level names. */
  listNames(): Promise<readonly string[]>
  /** Stop the kernel process and release its resources. */
  dispose(): Promise<void>
}
