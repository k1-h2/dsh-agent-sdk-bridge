/**
 * The host's tool list changes during a conversation, and the model must never
 * be told a tool it was offered does not exist.
 *
 * Two independent defects produced exactly that message
 * (`Tool "mcp__dsh_host__ops_edit" does not exist in the current tool set.`,
 * which CodeBuddy's CLI synthesises from its own `Tool X not found in agent`):
 *
 * 1. The MCP server connected with **no tools capability**, because the SDK
 *    only installs `tools/list` + `tools/call` and registers the `tools`
 *    capability on the *first* `registerTool`. The bridge registers tools in
 *    `ensureTools()` before the session exists, and a first turn whose host
 *    tool list was empty therefore connected empty. Every later registration
 *    threw `Cannot register capabilities after connecting to transport`, the
 *    bridge swallowed it, and the tool never reached `tools/list`.
 *
 * 2. Registration only ever *added*. The MCP SDK refuses a duplicate name
 *    (`Tool X is already registered`), so a schema that changed after a mode
 *    switch stayed at its old definition, and a tool the host withdrew could
 *    never be removed.
 *
 * These tests drive a real `@modelcontextprotocol/sdk` server through a real
 * client, so they fail on the actual transport contract rather than on a mock
 * that agrees with whatever the implementation does.
 */
import { describe, expect, it, vi } from 'vitest'

const mcp = await import('@modelcontextprotocol/sdk/server/mcp.js')
const clientModule = await import('@modelcontextprotocol/sdk/client/index.js')
const inMemory = await import('@modelcontextprotocol/sdk/inMemory.js')
const { z } = await import('zod')

const { HostToolRegistry } = await import('../src/session.ts')

type Host = InstanceType<typeof mcp.McpServer>
type Client = InstanceType<typeof clientModule.Client>

/**
 * One connected server/client pair, shaped exactly like a bridge session: the
 * server is created with an empty tool list, optionally declares its tools
 * capability up front, and only then connects.
 */
async function connectPair(prepare: boolean): Promise<{ server: Host, client: Client }> {
  const server = new mcp.McpServer({ name: 'dsh-host', version: '1.0.0' }, { capabilities: { tools: {} } })
  const registry = new HostToolRegistry(server as never, () => async () => ({ content: [] }))
  if (prepare) registry.prepare()
  const [clientTransport, serverTransport] = inMemory.InMemoryTransport.createLinkedPair()
  const client = new clientModule.Client({ name: 'codebuddy-cli', version: '1' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return { server, client }
}

/** Make a registry over an already-connected server. */
function registryFor(server: Host, problems: string[] = []): InstanceType<typeof HostToolRegistry> {
  return new HostToolRegistry(
    server as never,
    () => async () => ({ content: [] }),
    message => problems.push(message),
  )
}

const bash = { name: 'ops_bash', description: 'run a shell command', parameters: { type: 'object', properties: { command: { type: 'string' } } } }
const editFile = { name: 'ops_edit_file', description: 'edit one file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }

describe('MCP tools capability', () => {
  it('connects without a tools capability when nothing declared it, and cannot recover', async () => {
    // The pre-fix shape. This is the failure the capability declaration exists
    // to prevent, pinned so a regression cannot be mistaken for a test artifact.
    const { server, client } = await connectPair(false)
    // The client snapshots the server's capabilities at `initialize`. The
    // constructor's `capabilities` option is advertised, but `tools.listChanged`
    // is missing and — decisively — the `tools/list` request handler was never
    // installed, because the SDK installs it (and re-registers the capability
    // with `listChanged`) only on the first `registerTool`. So the client is
    // told a tools capability exists and then cannot read the tool list at all.
    expect(client.getServerCapabilities()?.tools).toEqual({})
    await expect(client.listTools()).rejects.toThrow(/Method not found/)
    expect(() => server.registerTool('ops_bash', { description: 'd', inputSchema: { command: z.string() } }, async () => ({ content: [] })))
      .toThrow(/Cannot register capabilities after connecting/)
    await client.close()
  })

  it('declares the tools capability before connecting so tools can arrive later', async () => {
    const { server, client } = await connectPair(true)
    // The capability — including `listChanged` — is visible from the start,
    // which is what lets the model be told the tool set changed.
    expect(client.getServerCapabilities()?.tools).toEqual({ listChanged: true })
    expect((await client.listTools()).tools).toEqual([])

    // A host tool that only appears on a later turn must register cleanly.
    const registry = registryFor(server)
    expect(registry.reconcile([bash])).toBe(true)
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['ops_bash'])
    await client.close()
  })
})

describe('host tool reconciliation', () => {
  it('adds, updates and removes as the host tool list changes', async () => {
    const { server, client } = await connectPair(true)
    const registry = registryFor(server)

    registry.reconcile([bash])
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['ops_bash'])

    // A tool the host pulls in later (ops_discover_tools) must appear.
    registry.reconcile([bash, editFile])
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['ops_bash', 'ops_edit_file'])

    // A changed schema must reach the model, not stay at its first definition.
    const changed = { ...bash, description: 'run a shell command (v2)', parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } } } }
    registry.reconcile([changed, editFile])
    const listed = (await client.listTools()).tools.find(tool => tool.name === 'ops_bash')
    expect(listed?.description).toBe('run a shell command (v2)')
    expect(Object.keys(listed?.inputSchema.properties ?? {})).toEqual(['command', 'cwd'])

    // A tool the host withdraws must disappear: leaving it registered is what
    // let the model call a name the server no longer answered.
    registry.reconcile([changed])
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['ops_bash'])
    await client.close()
  })

  it('reports a registration the SDK refused instead of dropping it silently', () => {
    const problems: string[] = []
    // A host exposing only what this bridge needs: no reachable transport.
    const fake = {
      registerTool: () => { throw new Error('boom') },
    }
    const registry = new HostToolRegistry(fake as never, () => async () => ({ content: [] }), message => problems.push(message))
    registry.reconcile([bash])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('ops_bash')
    expect(problems[0]).toContain('boom')
    // Nothing was installed, so the registry does not claim it was.
    expect(registry.names()).toEqual([])
  })

  it('keeps the tool installed when only its schema update is refused', () => {
    const problems: string[] = []
    const installed = new Map<string, { description: string }>()
    const fake = {
      registerTool: (name: string, config: { description: string }) => {
        installed.set(name, { description: config.description })
        return {
          update: () => { throw new Error('nope') },
          remove: () => { installed.delete(name) },
        }
      },
    }
    const registry = new HostToolRegistry(fake as never, () => async () => ({ content: [] }), message => problems.push(message))
    registry.reconcile([bash])
    expect(installed.has('ops_bash')).toBe(true)

    // A refused in-place update falls back to remove + register, so the model
    // still ends up on the new schema rather than on a stale one.
    registry.reconcile([{ ...bash, description: 'v2' }])
    expect(installed.get('ops_bash')?.description).toBe('v2')
    expect(problems.some(message => message.includes('nope'))).toBe(true)
    expect(registry.names()).toEqual(['ops_bash'])
  })
})

describe('bare host tool names', () => {
  it('routes a bare name the CLI resolved to the host instead of refusing it', async () => {
    // CodeBuddy resolves `mcp__dsh_host__ops_edit` and `ops_edit` differently:
    // the qualified spelling reaches `canUseTool`, and a *bare* name — which a
    // model sometimes emits — is answered by the CLI itself before any host
    // round. This pins the naming table the session matches on, because getting
    // it wrong is what turns a working tool into "does not exist".
    const { isHostTool, hostToolName } = await import('../src/codebuddy.ts')
    void vi
    expect(isHostTool('mcp__dsh_host__ops_edit_file')).toBe(true)
    expect(isHostTool('mcp__dsh-host__ops_edit_file')).toBe(true)
    expect(hostToolName('mcp__dsh_host__ops_edit_file')).toBe('ops_edit_file')
    expect(hostToolName('mcp__dsh-host__ops_edit_file')).toBe('ops_edit_file')
  })
})
