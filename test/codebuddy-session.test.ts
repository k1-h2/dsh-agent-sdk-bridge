/**
 * The host's tools must be visible to the model on its first turn, and the
 * CLI's own tools must never reach the host.
 *
 * `ensureTools` runs before the session (and its MCP server) exists, so it has
 * to replay the schemas when the CLI starts. It used to return early instead,
 * which left the model with no host tools: it called CodeBuddy's built-in
 * `Bash`/`ToolSearch`, and the host answered "unknown tool" and stopped.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  created: [] as any[],
  registered: [] as string[],
  messages: [] as any[],
  sent: [] as any[],
}))

vi.mock('../src/sdk.ts', () => ({
  codeBuddyEnvironment: (region: string) => region === 'cn' ? 'internal' : 'external',
  loadCodeBuddySdk: async () => ({
    createSdkMcpServer: () => ({
      instance: {
        registerTool: (name: string) => { fake.registered.push(name) },
      },
    }),
    unstable_v2_createSession: (options: any) => {
      fake.created.push(options)
      return {
        connect: async () => {},
        setModel: async () => {},
        send: async (message: any) => { fake.sent.push(message) },
        interrupt: async () => {},
        close: () => {},
        stream: async function* () {
          for (const message of fake.messages) yield message
        },
      }
    },
  }),
}))

// Set before importing the plugin: the state store resolves its path at load.
const root = mkdtempSync(join(tmpdir(), 'codebuddy-session-'))
process.env.DSH_CODUBUDDY_CLI_DIR = root
process.env.DSH_CODUBUDDY_STATE_PATH = join(root, 'state.json')

const { CodeBuddySession } = await import('../src/codebuddy.ts')

afterAll(() => { rmSync(root, { recursive: true, force: true }) })

function drain(session: InstanceType<typeof CodeBuddySession>, feed: any = null): Promise<any[]> {
  return (async () => {
    const chunks: any[] = []
    for await (const chunk of session.stream({ messages: [], model: 'model' } as any, feed)) chunks.push(chunk)
    return chunks
  })()
}

describe('CodeBuddySession host tools', () => {
  it('registers host tools before the CLI starts and disables built-ins', async () => {
    fake.created.length = 0
    fake.registered.length = 0
    fake.messages = [{ type: 'result', usage: { input_tokens: 1, output_tokens: 1 }, is_error: false }]

    const session = new CodeBuddySession('s-tools', 'model')
    session.configure('global', 'model')
    session.ensureTools([{
      name: 'ops_bash',
      description: 'Run a shell command',
      parameters: { type: 'object', properties: { command: { type: 'string' } } },
    }])

    // Nothing has spawned yet: the schema is held until the MCP server exists.
    expect(fake.created).toHaveLength(0)
    await drain(session)

    expect(fake.registered).toContain('ops_bash')
    // `tools: []` is the CLI's documented "disable all built-in tools"; MCP
    // tools are not built-ins, so the host's own tools stay available.
    expect(fake.created[0].tools).toEqual([])
    expect(fake.created[0].mcpServers['dsh-host']).toBeDefined()
    session.close()
  })

  it('does not forward a built-in CLI tool call to the host', async () => {
    fake.created.length = 0
    fake.messages = [
      { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: {} } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } } },
      { type: 'stream_event', event: { type: 'content_block_stop' } },
      { type: 'result', usage: { input_tokens: 3, output_tokens: 4 }, is_error: false },
    ]

    const session = new CodeBuddySession('s-builtin', 'model')
    session.configure('global', 'model')
    const chunks = await drain(session)

    expect(chunks.some(chunk => chunk.type === 'tool-call-delta')).toBe(false)
    expect(chunks.some(chunk => chunk.type === 'block-start' && chunk.blockType === 'tool-call')).toBe(false)
    session.close()
  })

  it('sends a pasted image as a vision content block', async () => {
    fake.created.length = 0
    fake.sent.length = 0
    fake.messages = [{ type: 'result', usage: { input_tokens: 1, output_tokens: 1 }, is_error: false }]

    const session = new CodeBuddySession('s-image', 'model')
    session.configure('global', 'model')
    const feed = [
      { type: 'text', text: '看看这张图' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    ]
    await drain(session, feed)

    // A bare ContentBlock[] is not accepted by send(); it must be wrapped, or
    // the picture silently disappears from the prompt.
    const sent = fake.sent[0]
    expect(sent).toMatchObject({ type: 'user', message: { role: 'user' } })
    expect(sent.message.content).toEqual([
      { type: 'text', text: '看看这张图' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    ])
    session.close()
  })

  it('keeps a text-only turn in the plain string shape', async () => {
    fake.created.length = 0
    fake.sent.length = 0
    fake.messages = [{ type: 'result', usage: { input_tokens: 1, output_tokens: 1 }, is_error: false }]

    const session = new CodeBuddySession('s-text', 'model')
    session.configure('global', 'model')
    await drain(session, '只有文字')

    expect(fake.sent[0]).toBe('只有文字')
    session.close()
  })

  it('forwards a host MCP tool call under its unprefixed name', async () => {
    // CodeBuddy rewrites the server name's hyphen to `_`; the Qoder CLI keeps
    // it. Both spellings name the same host tool and must be forwarded.
    for (const toolName of ['mcp__dsh_host__ops_bash', 'mcp__dsh-host__ops_bash']) {
      fake.created.length = 0
      fake.messages = [
        { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'toolu_host', name: toolName, input: {} } } },
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } } },
        { type: 'stream_event', event: { type: 'content_block_stop' } },
        { type: 'stream_event', event: { type: 'message_stop' } },
      ]

      const session = new CodeBuddySession(`s-host-${toolName}`, 'model')
      session.configure('global', 'model')
      const chunks = await drain(session)

      expect(chunks.some(chunk => chunk.type === 'block-start' && chunk.blockType === 'tool-call')).toBe(true)
      const call = chunks.find(chunk => chunk.type === 'tool-call-delta')
      expect(call.name).toBe('ops_bash')
      expect(chunks.at(-1)?.type).toBe('finish')
      session.close()
    }
  })
})
