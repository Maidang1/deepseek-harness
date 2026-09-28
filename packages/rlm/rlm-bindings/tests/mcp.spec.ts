import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { RlmHostReplyData, RlmHostRequestContext, RlmHostRequestEvent } from '@deepseek-ai/dsh-rlm-kernel'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMcpHostHandlers, readMcpServersFile } from '../src/mcp.ts'
import type { McpBindingDeps, McpServerConfig } from '../src/mcp.ts'

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

function request(data: RlmHostRequestEvent['data']): RlmHostRequestEvent {
  return { event: 'host_request', id: '1', data }
}

const context: RlmHostRequestContext = { agent: agent('s1'), signal: new AbortController().signal }

/** Unwrap an ok reply, failing the test on an error reply. */
function okResult(reply: RlmHostReplyData): JsonValue {
  if (reply.status !== 'ok') throw new Error('expected an ok reply')
  return reply.result
}

/** Invoke a handler, turning a synchronous validation throw into a rejection. */
async function call(
  handler: (request: RlmHostRequestEvent, context: RlmHostRequestContext) => Promise<RlmHostReplyData>,
  req: RlmHostRequestEvent,
): Promise<RlmHostReplyData> {
  return handler(req, context)
}

const httpServer: McpServerConfig = {
  type: 'http',
  url: 'https://mcp.example.com/sse',
  headers: { 'X-Tenant': 'acme' },
  bearerTokenEnvVar: 'EXAMPLE_TOKEN',
  enabledTools: ['search'],
  startupTimeoutMs: 5000,
}

const stdioServer: McpServerConfig = {
  type: 'stdio',
  command: '/usr/local/bin/mcp-fs',
  args: ['--root', '/repo'],
  cwd: '/repo',
  env: { API_KEY: { env: 'FS_API_KEY' } },
  disabledTools: ['write'],
}

describe('mcp.config', () => {
  it('requires a server name', async () => {
    const handlers = createMcpHostHandlers({})
    await expect(call(handlers['mcp.config']!, request({}))).rejects.toThrow('mcp.config requires a server')
    await expect(call(handlers['mcp.config']!, request({ server: '' }))).rejects.toThrow('mcp.config requires a server')
    await expect(call(handlers['mcp.config']!, request({ server: 42 }))).rejects.toThrow('mcp.config requires a server')
  })

  it('answers an empty config for an undeclared server', async () => {
    const handlers = createMcpHostHandlers({ servers: () => ({ web: httpServer }) })
    expect(okResult(await call(handlers['mcp.config']!, request({ server: 'missing' })))).toEqual({})
  })

  it('answers an empty config when no server source is wired', async () => {
    const handlers = createMcpHostHandlers({})
    expect(okResult(await call(handlers['mcp.config']!, request({ server: 'web' })))).toEqual({})
  })

  it('answers an empty config when the source has nothing declared', async () => {
    const handlers = createMcpHostHandlers({ servers: () => undefined })
    expect(okResult(await call(handlers['mcp.config']!, request({ server: 'web' })))).toEqual({})
  })

  it('passes a declared http server config through verbatim', async () => {
    const handlers = createMcpHostHandlers({ servers: () => ({ web: httpServer }) })
    expect(okResult(await call(handlers['mcp.config']!, request({ server: 'web' })))).toEqual(httpServer)
  })

  it('passes a declared stdio server config through verbatim', async () => {
    const handlers = createMcpHostHandlers({ servers: () => ({ fs: stdioServer }) })
    expect(okResult(await call(handlers['mcp.config']!, request({ server: 'fs' })))).toEqual(stdioServer)
  })

  it('re-reads the source on every request', async () => {
    let current: Readonly<Record<string, McpServerConfig>> | undefined = {}
    const handlers = createMcpHostHandlers({ servers: () => current })
    expect(okResult(await call(handlers['mcp.config']!, request({ server: 'web' })))).toEqual({})
    current = { web: httpServer }
    expect(okResult(await call(handlers['mcp.config']!, request({ server: 'web' })))).toEqual(httpServer)
  })
})

describe('mcp.refresh', () => {
  it('requires a server name', async () => {
    const handlers = createMcpHostHandlers({})
    await expect(call(handlers['mcp.refresh']!, request({}))).rejects.toThrow('mcp.refresh requires a server')
  })

  it('fails loud when the composition has no credential store', async () => {
    const handlers = createMcpHostHandlers({})
    await expect(call(handlers['mcp.refresh']!, request({ server: 'web' })))
      .rejects.toThrow('Could not refresh credentials for web')
  })

  it('fails loud when the store holds no credential for the server', async () => {
    const handlers = createMcpHostHandlers({ refreshCredential: () => Promise.resolve(undefined) })
    await expect(call(handlers['mcp.refresh']!, request({ server: 'web' })))
      .rejects.toThrow('Could not refresh credentials for web')
  })

  it('fails loud when the refresh produces an empty key', async () => {
    const handlers = createMcpHostHandlers({ refreshCredential: () => Promise.resolve('') })
    await expect(call(handlers['mcp.refresh']!, request({ server: 'web' })))
      .rejects.toThrow('Could not refresh credentials for web')
  })

  it('acknowledges a refresh that produced a fresh key', async () => {
    const refreshed: string[] = []
    const deps: McpBindingDeps = {
      refreshCredential: (server) => { refreshed.push(server); return Promise.resolve('fresh-key') },
    }
    const handlers = createMcpHostHandlers(deps)
    expect(okResult(await call(handlers['mcp.refresh']!, request({ server: 'web' })))).toEqual({})
    expect(refreshed).toEqual(['web'])
  })
})

describe('mcp.begin_login', () => {
  it('is not exposed when no interactive login is wired', () => {
    const handlers = createMcpHostHandlers({})
    expect(handlers['mcp.begin_login']).toBeUndefined()
  })

  it('is exposed once an interactive login is wired', async () => {
    const logins: string[] = []
    const handlers = createMcpHostHandlers({
      beginLogin: (server) => { logins.push(server); return Promise.resolve() },
    })
    const handler = handlers['mcp.begin_login']
    expect(handler).toBeDefined()
    expect(okResult(await call(handler!, request({ server: 'web' })))).toEqual({})
    expect(logins).toEqual(['web'])
  })

  it('requires a server name', async () => {
    const handlers = createMcpHostHandlers({ beginLogin: () => Promise.resolve() })
    await expect(call(handlers['mcp.begin_login']!, request({})))
      .rejects.toThrow('mcp.begin_login requires a server')
  })
})

describe('readMcpServersFile', () => {
  it('reads a declared server map', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-servers-'))
    const file = join(dir, 'servers.json')
    writeFileSync(file, JSON.stringify({
      web: { type: 'http', url: 'https://example.com/mcp' },
      local: { type: 'stdio', command: 'mcp-server', args: ['--fast'] },
    }))
    expect(readMcpServersFile(file)).toEqual({
      web: { type: 'http', url: 'https://example.com/mcp' },
      local: { type: 'stdio', command: 'mcp-server', args: ['--fast'] },
    })
  })

  it('reads a missing file as no declared servers', () => {
    expect(readMcpServersFile(join(tmpdir(), 'mcp-servers-missing', 'nope.json'))).toEqual({})
  })

  it('reads invalid JSON as no declared servers', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mcp-servers-')), 'bad.json')
    writeFileSync(file, '{not json')
    expect(readMcpServersFile(file)).toEqual({})
  })

  it('reads a non-object document as no declared servers', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mcp-servers-')), 'array.json')
    writeFileSync(file, JSON.stringify([{ type: 'stdio', command: 'x' }]))
    expect(readMcpServersFile(file)).toEqual({})
  })

  it('skips entries that are not server configs', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mcp-servers-')), 'mixed.json')
    writeFileSync(file, JSON.stringify({
      good: { type: 'http', url: 'https://example.com/mcp' },
      noType: { url: 'https://example.com/mcp' },
      badType: { type: 'sse' },
      notObject: 'nope',
      list: [],
      nil: null,
    }))
    expect(readMcpServersFile(file)).toEqual({
      good: { type: 'http', url: 'https://example.com/mcp' },
    })
  })
})
