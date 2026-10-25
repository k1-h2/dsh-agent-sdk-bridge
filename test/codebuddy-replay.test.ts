/**
 * A reply that spans a tool round must not be printed twice.
 *
 * The CLI streams a message's deltas, then sends `message_stop`, then the
 * assembled `assistant` echo, and only after the host returns the tool result
 * does the turn finish. This bridge has to end the host turn at `message_stop`
 * (waiting for `result` would deadlock on that very cycle), so the echo is
 * still sitting in the SDK's buffer and is delivered at the start of the NEXT
 * `stream()` call. Treating it as new content re-emitted the previous round's
 * text — the duplicate sentences users saw between tool rows.
 *
 * The mock below reproduces the SDK's buffering rather than replaying a fixed
 * message list, because that buffering is the behaviour under test: a turn
 * that stops reading early leaves its tail for the next turn.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  sent: [] as unknown[],
  /** Messages the mock "CLI" has produced but the session has not read yet. */
  pending: [] as any[],
  /** Messages each upcoming `stream()` call appends before delivering. */
  turns: [] as any[][],
}))

vi.mock('../src/sdk.ts', () => ({
  codeBuddyEnvironment: (region: string) => region === 'cn' ? 'internal' : 'external',
  loadCodeBuddySdk: async () => ({
    createSdkMcpServer: () => ({ instance: { registerTool: () => {} } }),
    unstable_v2_createSession: () => ({
      connect: async () => {},
      setModel: async () => {},
      send: async (message: unknown) => { fake.sent.push(message) },
      interrupt: async () => {},
      close: () => {},
      stream: async function* () {
        const turn = fake.turns.shift() ?? []
        fake.pending.push(...turn)
        while (fake.pending.length > 0) yield fake.pending.shift()
      },
    }),
  }),
}))

// Set before importing the plugin: the state store resolves its path at load.
const root = mkdtempSync(join(tmpdir(), 'codebuddy-replay-'))
// Names as the state store reads them, so the test never touches a real login.
process.env.DSH_CODUBUDDY_CLI_DIR = root
process.env.DSH_CODUBUDDY_STATE_PATH = join(root, 'state.json')

const { CodeBuddySession } = await import('../src/codebuddy.ts')

afterAll(() => { rmSync(root, { recursive: true, force: true }) })

const MODEL = 'hy3'
const FIRST_ID = 'msg-round-one'
const SECOND_ID = 'msg-round-two'
const FIRST_TEXT = 'Now update src/index.ts.'
const SECOND_TEXT = 'Done.'

const TOOL = {
  name: 'ops_probe',
  description: 'Probe tool. Returns pong.',
  parameters: { type: 'object', properties: { msg: { type: 'string' } } },
}

function textEvent(type: string, extra: Record<string, unknown> = {}): any {
  return { type: 'stream_event', event: { type, ...extra } }
}

function textDeltas(chunks: any[]): string {
  return chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
}

/** Turn one: announce the work, call a host tool, then stop for the host. */
function queueToolRound(): void {
  fake.turns.push([
    textEvent('message_start', { message: { id: FIRST_ID, usage: { input_tokens: 12, output_tokens: 0 } } }),
    textEvent('content_block_start', { content_block: { type: 'text' } }),
    textEvent('content_block_delta', { delta: { type: 'text_delta', text: FIRST_TEXT } }),
    textEvent('content_block_stop'),
    textEvent('content_block_start', {
      content_block: { type: 'tool_use', id: 'toolu_probe', name: 'mcp__dsh-host__ops_probe', input: {} },
    }),
    textEvent('content_block_delta', { delta: { type: 'input_json_delta', partial_json: '{"msg":"ping"}' } }),
    textEvent('content_block_stop'),
    textEvent('message_delta', { usage: { input_tokens: 12, output_tokens: 9 } }),
    textEvent('message_stop'),
    // Produced after the turn ended, so the next stream() delivers it first.
    {
      type: 'assistant',
      uuid: 'uuid-round-one',
      session_id: 's-replay',
      message: { id: FIRST_ID, content: [{ type: 'text', text: FIRST_TEXT }] },
    },
  ])
}

/** Turn two: a normal answer that never mentions the first round's text. */
function queueAnswer(): void {
  fake.turns.push([
    textEvent('message_start', { message: { id: SECOND_ID } }),
    textEvent('content_block_start', { content_block: { type: 'text' } }),
    textEvent('content_block_delta', { delta: { type: 'text_delta', text: SECOND_TEXT } }),
    textEvent('content_block_stop'),
    textEvent('message_stop'),
    {
      type: 'assistant',
      uuid: 'uuid-round-two',
      session_id: 's-replay',
      message: { id: SECOND_ID, content: [{ type: 'text', text: SECOND_TEXT }] },
    },
    { type: 'result', usage: { input_tokens: 20, output_tokens: 4 }, is_error: false },
  ])
}

interface SessionLike {
  configure(region: string, model: string): void
  ensureTools(tools: unknown[]): void
  deliverToolResults(tail: unknown[]): void
  close(): void
  stream(options: unknown, feed: string | null): AsyncIterable<any>
}

async function drain(session: SessionLike, feed: string | null): Promise<any[]> {
  const chunks: any[] = []
  for await (const chunk of session.stream({ messages: [], model: MODEL }, feed)) chunks.push(chunk)
  return chunks
}

describe('CodeBuddy replayed assistant message', () => {
  it('does not re-emit a tool round’s text on the next turn', async () => {
    fake.pending.length = 0
    fake.turns.length = 0
    fake.sent.length = 0
    queueToolRound()
    queueAnswer()

    const session = new CodeBuddySession('s-replay', MODEL) as unknown as SessionLike
    session.configure('cn', MODEL)
    session.ensureTools([TOOL])

    const first = await drain(session, 'Call ops_probe with msg="ping".')
    expect(first.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(textDeltas(first)).toBe(FIRST_TEXT)
    const call = first.find(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
    expect(call.block.name).toBe('ops_probe')

    // The echo of the first round is still buffered here, exactly as in flight.
    expect(fake.pending.length).toBeGreaterThan(0)
    session.deliverToolResults([{
      role: 'tool',
      toolCallId: call.block.id,
      content: [{ type: 'text', text: 'pong' }],
      isError: false,
    }])

    const second = await drain(session, null)
    expect(second.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    // The whole reply is the new answer: no leftover sentence from round one.
    expect(textDeltas(second)).toBe(SECOND_TEXT)
    expect(textDeltas(second)).not.toContain(FIRST_TEXT)
    session.close()
  })

  it('still emits a message that only ever arrives assembled', async () => {
    // Non-streaming transports (and some CLI versions) send no deltas at all.
    fake.pending.length = 0
    fake.turns.length = 0
    fake.turns.push([
      {
        type: 'assistant',
        uuid: 'uuid-assembled',
        session_id: 's-assembled',
        message: { id: 'msg-assembled', content: [{ type: 'text', text: 'assembled only' }] },
      },
      { type: 'result', usage: { input_tokens: 3, output_tokens: 2 }, is_error: false },
    ])

    const session = new CodeBuddySession('s-assembled', MODEL) as unknown as SessionLike
    session.configure('cn', MODEL)
    const chunks = await drain(session, 'hello')
    expect(textDeltas(chunks)).toBe('assembled only')
    session.close()
  })
})
