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
  /** `setConfig` payloads the session pushed to the CLI. */
  configs: [] as any[],
  /** When set, the CLI rejects the config the way `Allowed: <none>` models do. */
  refuseConfig: false,
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
        setConfig: async (config: any) => {
          if (fake.refuseConfig) throw new Error('Invalid context_window value: Allowed: <none>')
          fake.configs.push(config)
        },
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

  it('pushes the chosen context window into the inner session', async () => {
    fake.created.length = 0
    fake.configs.length = 0
    fake.messages = [{ type: 'result', usage: { input_tokens: 1, output_tokens: 1 }, is_error: false }]

    // The global catalog's default budget is 300K even though the model allows
    // 1M. Without this call the session keeps compacting a history the host
    // shows at 1M, and the conversation collapses to a summary mid-turn.
    const session = new CodeBuddySession('s-window', 'deepseek-v4.1-flash')
    session.configure('global', 'deepseek-v4.1-flash', { contextWindow: 1_000_000 })
    await drain(session, 'hi')
    expect(fake.configs).toEqual([{ contextWindow: 1_000_000 }])

    // Sent once per model+window: repeating it on every request would be noise.
    await drain(session, 'again')
    expect(fake.configs).toHaveLength(1)

    // The CLI validates the value against the current model, so a switch
    // re-applies it.
    session.configure('global', 'glm-5.3', { contextWindow: 1_000_000 })
    await drain(session, 'switched')
    expect(fake.configs).toHaveLength(2)
    session.close()
  })

  it('leaves the session budget to the CLI when no window was chosen', async () => {
    fake.configs.length = 0
    fake.messages = [{ type: 'result', usage: { input_tokens: 1, output_tokens: 1 }, is_error: false }]

    // No choice means the CLI's own default is already the window the host was
    // told about, so there is nothing to push.
    const session = new CodeBuddySession('s-no-window', 'hy3')
    session.configure('global', 'hy3')
    await drain(session, 'hi')
    expect(fake.configs).toEqual([])
    session.close()
  })

  it('re-sends the model default when the page goes back to default', async () => {
    fake.configs.length = 0
    fake.messages = [{ type: 'result', usage: { input_tokens: 1, output_tokens: 1 }, is_error: false }]

    // The override lives for the life of the CLI process. The CLI rejects a
    // null clear ("contextWindow must be a positive safe integer"), so the
    // adapter sends the model's own default instead of dropping the choice:
    // otherwise the session keeps 1M while the host divides by 300K.
    const session = new CodeBuddySession('s-default', 'deepseek-v4.1-flash')
    session.configure('global', 'deepseek-v4.1-flash', { contextWindow: 1_000_000 })
    await drain(session, 'hi')
    expect(fake.configs).toEqual([{ contextWindow: 1_000_000 }])

    session.configure('global', 'deepseek-v4.1-flash', { contextWindow: 300_000 })
    await drain(session, 'hi again')
    expect(fake.configs).toEqual([{ contextWindow: 1_000_000 }, { contextWindow: 300_000 }])

    // Repeating the same budget is not re-sent.
    await drain(session, 'hi once more')
    expect(fake.configs).toHaveLength(2)
    session.close()
  })

  it('keeps the turn alive when the model refuses the window', async () => {
    fake.configs.length = 0
    fake.refuseConfig = true
    fake.messages = [
      { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } } },
      { type: 'stream_event', event: { type: 'content_block_stop' } },
      { type: 'result', usage: { input_tokens: 1, output_tokens: 1 }, is_error: false },
    ]

    const session = new CodeBuddySession('s-refused', 'hy3')
    session.configure('global', 'hy3', { contextWindow: 192_000 })
    const chunks = await drain(session, 'hi')
    fake.refuseConfig = false

    // The rejection is not fatal: a model with one fixed window keeps its
    // default and the turn still runs.
    expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')).toBe('ok')
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    session.close()
  })
})
