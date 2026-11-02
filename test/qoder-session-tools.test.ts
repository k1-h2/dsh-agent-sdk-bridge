/**
 * The Qoder session's tool surface as the inner CLI actually sees it.
 *
 * No test here ever built a `QoderSession`, which is why the missing tools
 * capability survived on this path unnoticed: the CodeBuddy session test mocked
 * the SDK with a one-method fake (`registerTool: () => {}`), so a server that
 * could never answer `tools/list` looked perfectly registered. This drives the
 * real `McpServer` the Qoder SDK creates and connects a real MCP client to it at
 * spawn time — exactly what qodercli does — and reads the tool list over that
 * transport.
 *
 * Two things are pinned. The first is ordering: `prepare()` must declare the
 * `tools` capability *before* the transport connects, because the MCP SDK
 * refuses a capability change afterwards — a session whose first turn published
 * no host tools would otherwise connect with no tools at all, and the CLI's
 * `tools/list` would answer `Method not found (-32601)`. The second is that the
 * same session can still take a tool that appears on a later turn and drop one
 * the host withdrew, which the previous add-only replay could not do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => {
  const state: {
    /** What the CLI could read at the moment the inner process was spawned. */
    atSpawn: string[]
    /** The server's declared capabilities when `query()` was called. */
    capabilities: Record<string, unknown>
    /** The real MCP client standing in for qodercli's MCP connection. */
    client: any
    /** The live query's sink, installed when the fake `query()` runs. */
    deliver: ((message: unknown) => void) | null
    /** Hand one SDK message to the live turn, buffering it until one exists. */
    emit: (message: unknown) => void
    /** Messages emitted before a query existed, flushed when one appears. */
    outbox: unknown[]
    /** Resolves once the spawn-time connection and its first list are done. */
    pendingConnect: Promise<void>
    queries: number
  } = {
    atSpawn: [],
    capabilities: {},
    client: null,
    deliver: null,
    emit: (message: unknown) => {
      if (state.deliver !== null) state.deliver(message)
      else state.outbox.push(message)
    },
    outbox: [],
    pendingConnect: Promise.resolve(),
    queries: 0,
  }
  return state
})

const inMemory = await import('@modelcontextprotocol/sdk/inMemory.js')
const clientModule = await import('@modelcontextprotocol/sdk/client/index.js')

vi.mock('../src/sdk.ts', () => ({
  isDaemonConflict: () => false,
  resetSdk: () => {},
  probeDaemon: async () => {},
  loadSdk: async () => ({
    qodercliAuth: () => ({ type: 'oauth' }),
    query: ({ options }: any) => {
      fake.queries++
      const instance = options.mcpServers['dsh-host'].instance
      // Snapshot what the CLI could list, at the moment it starts.
      fake.capabilities = JSON.parse(JSON.stringify(instance.server?._capabilities ?? {}))
      const [clientSide, serverSide] = inMemory.InMemoryTransport.createLinkedPair()
      const client = new clientModule.Client({ name: 'qodercli', version: '1' })
      fake.pendingConnect = Promise.all([client.connect(clientSide), instance.connect(serverSide)]).then(async () => {
        fake.client = client
        try {
          fake.atSpawn = (await client.listTools()).tools.map((tool: any) => tool.name)
        } catch (error) {
          fake.atSpawn = [`ERROR: ${error instanceof Error ? error.message : String(error)}`]
        }
      })
      return makeQuery()
    },
  }),
}))

vi.mock('../src/cli.ts', () => ({
  cliConflictMessage: () => 'conflict',
  cliFailureText: (text: string) => text,
  foreignCliOverride: () => undefined,
  qoderCliOptions: () => ({}),
  resolveQoderCli: () => 'C:/fake/qodercli.exe',
}))

const { QoderSession } = await import('../src/session.ts')

/**
 * A stand-in for the SDK's `Query`: one long-lived async iterator, like a real
 * CLI whose process outlives the turn that started it. A short-lived iterator
 * ends the session's consumer after the first turn and makes every later turn
 * hang — which is how this file caught its own bug instead of the real one.
 */
function makeQuery(): any {
  const queue: unknown[] = []
  let waiting: (() => void) | null = null
  let closed = false
  const wake = (): void => {
    const settle = waiting
    waiting = null
    settle?.()
  }
  const sink = (message: unknown): void => {
    queue.push(message)
    wake()
  }
  fake.deliver = sink
  for (const buffered of fake.outbox.splice(0)) sink(buffered)
  return {
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      return {
        async next(): Promise<IteratorResult<unknown>> {
          await fake.pendingConnect
          while (true) {
            if (queue.length > 0) return { done: false, value: queue.shift() }
            if (closed) return { done: true, value: undefined }
            await new Promise<void>(resolve => {
              waiting = () => resolve()
            })
          }
        },
      }
    },
    interrupt: async () => {},
    // The session closes the query on teardown; releasing the parked iterator
    // keeps a closed session from holding the test process open.
    close: async () => {
      closed = true
      wake()
    },
  }
}

const bash = { name: 'ops_bash', description: 'Run a shell command', parameters: { type: 'object', properties: { command: { type: 'string' } } } }
const editFile = { name: 'ops_edit_file', description: 'Edit one file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }
/** Ends the inner turn the way qodercli's result frame does. */
const RESULT = { type: 'result', usage: { input_tokens: 10, output_tokens: 2 } }

/**
 * Run one host turn to its end. Emission is buffered, so the turn's frames can
 * be handed over before the inner process has even been spawned.
 * @param messages - SDK frames for this turn, in order.
 * @param feed - literal feed text, or null for a tool-result continuation.
 */
async function runTurn(
  session: InstanceType<typeof QoderSession>,
  messages: readonly unknown[],
  feed: unknown = 'hi',
): Promise<unknown[]> {
  for (const message of messages) fake.emit(message)
  const chunks: unknown[] = []
  for await (const chunk of session.stream({ messages: [], model: 'm' } as any, feed)) chunks.push(chunk)
  return chunks
}

/** Names the connected CLI-side client can read right now. */
async function listed(): Promise<string[]> {
  await fake.pendingConnect
  return (await fake.client.listTools()).tools.map((tool: any) => tool.name)
}

/** The full definition the CLI-side client is handed for one tool. */
async function definition(name: string): Promise<any> {
  await fake.pendingConnect
  return (await fake.client.listTools()).tools.find((tool: any) => tool.name === name)
}

beforeEach(() => {
  // The client belongs to the query that started it, so each test resets all of
  // the connection state, not just the assertions.
  fake.atSpawn = []
  fake.capabilities = {}
  fake.client = null
  fake.deliver = null
  fake.outbox = []
  fake.queries = 0
  fake.pendingConnect = Promise.resolve()
})

afterEach(async () => {
  await fake.client?.close().catch(() => undefined)
  fake.client = null
})

describe('Qoder session tool surface', () => {
  it('declares the tools capability before the CLI spawns, even with no host tools yet', async () => {
    const session = new QoderSession('q-empty', 'm')
    session.setModel('m')
    // The host published nothing on this first turn: the shape that used to
    // strand the session with no tools capability for the rest of its life.
    session.ensureTools([])
    await runTurn(session, [RESULT])

    expect(fake.queries).toBe(1)
    expect(fake.capabilities).toEqual({ tools: { listChanged: true } })
    // Readable, and honestly empty: a `tools/list` that answers nothing is the
    // pre-fix failure, not this one.
    expect(fake.atSpawn).toEqual([])
    session.close()
  })

  it('installs the first turn host tools before spawning so the CLI lists them', async () => {
    const session = new QoderSession('q-first', 'm')
    session.setModel('m')
    session.ensureTools([bash])
    await runTurn(session, [RESULT])

    // The tool is registered before `query()` runs, which is the ordering the
    // lazy spawn exists to protect.
    expect(fake.atSpawn).toEqual(['ops_bash'])
    session.close()
  })

  it('serves a tool the host only offers after a tool-less first turn', async () => {
    // The combination that was fatal before: nothing to register on turn one,
    // so the server connected with no handlers and no capability, and the first
    // `ops_bash` of turn two could only throw — which the old code swallowed,
    // leaving the model calling a tool its own `tools/list` never carried.
    const session = new QoderSession('q-toolless', 'm')
    session.setModel('m')
    session.ensureTools([])
    await runTurn(session, [RESULT])
    expect(fake.atSpawn).toEqual([])

    session.ensureTools([bash])
    await runTurn(session, [RESULT], null)
    expect(await listed()).toEqual(['ops_bash'])
    session.close()
  })

  it('serves a tool the host only offers on a later turn', async () => {
    const session = new QoderSession('q-later', 'm')
    session.setModel('m')
    session.ensureTools([bash])
    await runTurn(session, [RESULT])
    expect(await listed()).toEqual(['ops_bash'])

    // `ops_discover_tools` resolves a deferred capability; DSH tells the model
    // about it with a `tool-addition` block, and the model calls it next turn.
    session.ensureTools([bash, editFile])
    await runTurn(session, [RESULT], null)
    expect((await listed()).sort()).toEqual(['ops_bash', 'ops_edit_file'])
    session.close()
  })

  it('takes back a tool the host withdrew and replaces a changed schema', async () => {
    const session = new QoderSession('q-withdraw', 'm')
    session.setModel('m')
    session.ensureTools([bash, editFile])
    await runTurn(session, [RESULT])
    expect((await listed()).sort()).toEqual(['ops_bash', 'ops_edit_file'])

    // A `dsh-ops` mode switch widens `ops_bash` and drops `ops_edit_file`. The
    // old add-only replay threw `already registered` on the change and swallowed
    // it, so the model kept the first schema; and a withdrawn tool stayed
    // callable, so a call to it parked a handler no host request would answer.
    const widened = { ...bash, parameters: { type: 'object', properties: { command: { type: 'string' }, workdir: { type: 'string' } } } }
    session.ensureTools([widened])
    await runTurn(session, [RESULT], null)

    expect(await listed()).toEqual(['ops_bash'])
    expect(Object.keys((await definition('ops_bash')).inputSchema.properties)).toEqual(['command', 'workdir'])
    session.close()
  })
})
