/**
 * Host bindings for the RLM Python runtime's `mcp.*` host requests. The
 * kernel owns the MCP client itself (`py/rlm/mcp.py`); the host only answers
 * where a server's connection configuration lives (`mcp.config`), refreshes a
 * stored credential the kernel re-reads afterwards (`mcp.refresh`), and, when
 * the composition wires an interactive login, starts one (`mcp.begin_login`).
 *
 * @module @deepseek-ai/dsh-rlm-bindings/mcp
 */

import type {
  RlmHostRequestEvent,
  RlmHostRequestHandler,
  RlmHostRequestHandlers,
} from '@deepseek-ai/dsh-rlm-kernel'
import { ok } from './read.ts'

/** One user-declared Streamable HTTP MCP server, in the kernel client's wire shape. */
export type McpHttpServerConfig = {
  /** Selects the Streamable HTTP transport. */
  type: 'http'
  /** MCP endpoint URL. */
  url: string
  /** Extra headers attached to every MCP request. */
  headers?: Record<string, string>
  /** Environment variable holding a static bearer token (skips OAuth). */
  bearerTokenEnvVar?: string
  /** Whether the kernel authenticates with a stored OAuth credential (`mcp:<server>`). */
  oauth?: boolean
  /** Force-disable even when credentials exist. */
  enabled?: boolean
  /** Allowlist of tool names the kernel exposes. */
  enabledTools?: string[]
  /** Blocklist of tool names the kernel hides. */
  disabledTools?: string[]
  /** Startup handshake timeout in milliseconds. */
  startupTimeoutMs?: number
  /** Per-call timeout in milliseconds. */
  callTimeoutMs?: number
}

/** One user-declared stdio MCP server, in the kernel client's wire shape. */
export type McpStdioServerConfig = {
  /** Selects the child-process stdio transport. */
  type: 'stdio'
  /** Executable used to start the server. */
  command: string
  /** Arguments passed directly, without shell interpolation. */
  args?: string[]
  /** Working directory for the child process. */
  cwd?: string
  /** Environment variables resolved from the kernel environment. */
  env?: Record<string, { env: string }>
  /** Force-disable the server. */
  enabled?: boolean
  /** Allowlist of tool names the kernel exposes. */
  enabledTools?: string[]
  /** Blocklist of tool names the kernel hides. */
  disabledTools?: string[]
  /** Startup handshake timeout in milliseconds. */
  startupTimeoutMs?: number
  /** Per-call timeout in milliseconds. */
  callTimeoutMs?: number
}

/** User-declared MCP server configuration the kernel connects with. */
export type McpServerConfig = McpHttpServerConfig | McpStdioServerConfig

/** The composition pieces the MCP host handlers need, captured at load. */
export interface McpBindingDeps {
  /**
   * Reads the current user-declared MCP servers (name → config). Re-read on
   * every request, so a configuration change reaches the next kernel
   * connection without a plugin restart. When omitted, every server reads as
   * undeclared and the kernel raises its own "not declared" error.
   */
  readonly servers?: () => Readonly<Record<string, McpServerConfig>> | undefined
  /**
   * Refresh one server's stored credential and return the fresh key. The
   * kernel re-reads the credential store itself after this wire answers, so
   * the refresh must persist what it produced. When omitted the composition
   * has no credential store, and every refresh fails loud rather than
   * reporting a success the kernel could not observe.
   */
  readonly refreshCredential?: (server: string) => Promise<string | undefined>
  /**
   * Start an interactive host-side login for one server. When omitted the
   * `mcp.begin_login` handler is not registered at all, matching the
   * reference host: a handler whose only behavior is to throw is never
   * exposed.
   */
  readonly beginLogin?: (server: string) => Promise<void>
}

/**
 * Read the required `server` member of one `mcp.*` payload.
 *
 * @param data - the `host_request` payload.
 * @param operation - the wire type the error message names.
 * @returns the server name.
 */
function serverField(data: RlmHostRequestEvent['data'], operation: string): string {
  const value = data['server']
  const server = typeof value === 'string' ? value : ''
  if (server.length === 0) throw new Error(`${operation} requires a server`)
  return server
}

/**
 * Assemble the MCP host handlers the bindings answer.
 *
 * The map holds `mcp.config` and `mcp.refresh` unconditionally;
 * `mcp.begin_login` appears only when the composition wired an interactive
 * login, so the kernel never meets a handler whose only behavior is to throw.
 *
 * @param deps - the composition services captured at load.
 * @returns the handler map to register on `ctx.rlmKernel`.
 */
export function createMcpHostHandlers(deps: McpBindingDeps): RlmHostRequestHandlers {
  const servers = deps.servers ?? (() => undefined)
  const handlers: Record<string, RlmHostRequestHandler> = {
    'mcp.config': (request) => {
      const server = serverField(request.data, 'mcp.config')
      const config = servers()?.[server]
      return Promise.resolve(ok(config === undefined ? {} : { ...config }))
    },
    'mcp.refresh': async (request) => {
      const server = serverField(request.data, 'mcp.refresh')
      const refresh = deps.refreshCredential
      const key = refresh === undefined ? undefined : await refresh(server)
      if (key !== undefined && key.length > 0) return ok({})
      throw new Error(`Could not refresh credentials for ${server}`)
    },
  }
  const beginLogin = deps.beginLogin
  if (beginLogin !== undefined) {
    handlers['mcp.begin_login'] = async (request) => {
      const server = serverField(request.data, 'mcp.begin_login')
      await beginLogin(server)
      return ok({})
    }
  }
  return handlers
}
