/**
 * CodeBuddy's per-turn token accounting.
 *
 * Three properties matter, and each was wrong or fragile before:
 *
 * - Output tokens must be the provider's count. The adapter used to price the
 *   generated text locally, which under-reported short turns by 2-4x (a live
 *   turn reported 20 where the CLI metered 67).
 * - `input_tokens` includes cache traffic. The CLI's own modelUsage reports
 *   `inputTokens = input_tokens - cache_read`, so the harness's disjoint
 *   buckets are the remainder plus the cache counts. Pressure therefore adds
 *   back to exactly the prompt the provider counted.
 * - `result.usage` is cumulative for the whole inner session, never one
 *   request. A turn without a `message_delta` must not adopt it (the context
 *   ring would jump by millions), nor report zero (it would collapse).
 *
 * The mock SDK is deliberately dumb: each `stream()` yields the messages
 * queued for that turn. Buffering across turns is covered separately in
 * `codebuddy-replay.test.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  turns: [] as any[][],
  sent: [] as unknown[],
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
        for (const message of turn) yield message
      },
    }),
  }),
}))

const root = mkdtempSync(join(tmpdir(), 'codebuddy-usage-'))
process.env.DSH_CODUBUDDY_CLI_DIR = root
process.env.DSH_CODUBUDDY_STATE_PATH = join(root, 'state.json')

const { CodeBuddySession } = await import('../src/codebuddy.ts')

afterAll(() => { rmSync(root, { recursive: true, force: true }) })

const MODEL = 'deepseek-v4.1-flash'

function ev(type: string, extra: Record<string, unknown> = {}): any {
  return { type: 'stream_event', event: { type, ...extra } }
}

function start(id: string, usage?: Record<string, number>): any {
  return ev('message_start', {
    message: {
      id,
      usage: usage ?? {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  })
}

function delta(usage: Record<string, number>): any {
  return ev('message_delta', { usage })
}

function textBlock(text: string): any[] {
  return [
    ev('content_block_start', { content_block: { type: 'text' } }),
    ev('content_block_delta', { delta: { type: 'text_delta', text } }),
    ev('content_block_stop'),
  ]
}

function assembled(id: string, text: string): any {
  return {
    type: 'assistant',
    uuid: `uuid-${id}`,
    session_id: 's-usage',
    message: { id, content: [{ type: 'text', text }] },
  }
}

function result(usage?: Record<string, number>): any {
  return {
    type: 'result',
    subtype: 'success',
    usage: usage ?? {
      input_tokens: 99_999_999,
      output_tokens: 424_242,
      cache_read_input_tokens: 88_888_888,
      cache_creation_input_tokens: 0,
    },
    is_error: false,
  }
}

interface SessionLike {
  configure(region: string, model: string): void
  ensureTools(tools: unknown[]): void
  stream(options: unknown, feed: string | null): AsyncIterable<any>
  close(): void
}

function newSession(): SessionLike {
  const session = new CodeBuddySession('s-usage', MODEL) as unknown as SessionLike
  session.configure('cn', MODEL)
  return session
}

async function drain(session: SessionLike, feed: string | null = 'hi'): Promise<any[]> {
  const chunks: any[] = []
  for await (const chunk of session.stream({ messages: [], model: MODEL }, feed)) chunks.push(chunk)
  return chunks
}

function usageOf(chunks: any[]): any {
  const chunk = chunks.find(entry => entry.type === 'usage')
  if (chunk === undefined) throw new Error('no usage chunk emitted')
  return chunk.usage
}

beforeEach(() => {
  fake.turns.length = 0
  fake.sent.length = 0
})

describe('CodeBuddy usage accounting', () => {
  it('reports the provider counts and subtracts cache traffic', async () => {
    fake.turns.push([
      start('m1'),
      ...textBlock('hi'),
      delta({ input_tokens: 3330, cache_read_input_tokens: 512, cache_creation_input_tokens: 0, output_tokens: 224 }),
      ev('message_stop'),
      assembled('m1', 'hi'),
      result(),
    ])
    const session = newSession()
    const usage = usageOf(await drain(session))

    // 3330 is the whole prompt; the harness wants its uncached remainder.
    expect(usage.inputTokens).toBe(2818)
    expect(usage.cacheReadTokens).toBe(512)
    expect(usage.cacheWriteTokens).toBe(0)
    // The text is two characters; the provider counted 224 output tokens.
    expect(usage.outputTokens).toBe(224)
    expect(usage.totalTokens).toBe(2818 + 512 + 224)
    expect(usage.reasoningTokens).toBeUndefined()
    session.close()
  })

  it('subtracts cache writes as well as reads from the prompt', async () => {
    fake.turns.push([
      start('m2'),
      ...textBlock('ok'),
      delta({ input_tokens: 1000, cache_read_input_tokens: 200, cache_creation_input_tokens: 100, output_tokens: 5 }),
      ev('message_stop'),
      assembled('m2', 'ok'),
      result(),
    ])
    const session = newSession()
    const usage = usageOf(await drain(session))

    expect(usage.inputTokens).toBe(700)
    expect(usage.cacheReadTokens).toBe(200)
    expect(usage.cacheWriteTokens).toBe(100)
    expect(usage.totalTokens).toBe(1000 + 5)
    session.close()
  })

  it('keeps the provider output count instead of a character estimate', async () => {
    fake.turns.push([
      start('m3'),
      ...textBlock('OK'),
      delta({ input_tokens: 4200, cache_read_input_tokens: 3000, output_tokens: 67 }),
      ev('message_stop'),
      assembled('m3', 'OK'),
      result(),
    ])
    const session = newSession()
    const usage = usageOf(await drain(session))

    expect(usage.outputTokens).toBe(67)
    expect(usage.inputTokens).toBe(1200)
    session.close()
  })

  it('reuses the last measured prompt when a turn has no delta', async () => {
    // Turn one measures a real prompt.
    fake.turns.push([
      start('a1'),
      ...textBlock('hello'),
      delta({ input_tokens: 3000, cache_read_input_tokens: 0, output_tokens: 10 }),
      ev('message_stop'),
      assembled('a1', 'hello'),
      result(),
    ])
    // Turn two streams assembled content only; its `result` is cumulative.
    fake.turns.push([
      start('a2'),
      assembled('a2', 'ok'),
      result({ input_tokens: 60_000, cache_read_input_tokens: 50_000, output_tokens: 40 }),
    ])

    const session = newSession()
    const first = usageOf(await drain(session, 'hello'))
    expect(first.inputTokens).toBe(3000)

    const second = usageOf(await drain(session, null))
    // Not zero (collapsed ring), not 60k/50k (session-cumulative result).
    expect(second.inputTokens).toBe(3000)
    expect(second.cacheReadTokens).toBe(0)
    expect(second.cacheWriteTokens).toBe(0)
    expect(second.totalTokens).toBe(3000 + second.outputTokens)
    session.close()
  })

  it('never adopts the cumulative result usage on a result-only turn', async () => {
    fake.turns.push([
      start('b1'),
      ...textBlock('hello'),
      delta({ input_tokens: 2500, cache_read_input_tokens: 500, output_tokens: 8 }),
      ev('message_stop'),
      assembled('b1', 'hello'),
      result(),
    ])
    fake.turns.push([result({ input_tokens: 70_000, cache_read_input_tokens: 60_000, output_tokens: 30 })])

    const session = newSession()
    await drain(session, 'hello')
    const chunks = await drain(session, null)
    const usage = usageOf(chunks)

    expect(usage.inputTokens).toBe(2000)
    expect(usage.cacheReadTokens).toBe(500)
    // The result-only turn has no content, so it ends as an empty response —
    // but the context reading it carries must still be the real prompt.
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    session.close()
  })

  it('clamps reasoning inside the metered output total', async () => {
    const reasoning = 'x'.repeat(400)
    fake.turns.push([
      start('c1'),
      ev('content_block_start', { content_block: { type: 'thinking' } }),
      ev('content_block_delta', { delta: { type: 'thinking_delta', thinking: reasoning } }),
      ev('content_block_stop'),
      ...textBlock('OK'),
      delta({ input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 5 }),
      ev('message_stop'),
      assembled('c1', 'OK'),
      result(),
    ])
    const session = newSession()
    const usage = usageOf(await drain(session))

    expect(usage.outputTokens).toBe(5)
    expect(usage.reasoningTokens).toBeLessThanOrEqual(5)
    session.close()
  })

  it('keeps every fallback bucket a whole number', async () => {
    // No usage frames at all: the estimator prices characters and returns
    // fractions, which the host's usage projection rejects as non-integers.
    fake.turns.push([
      start('d1'),
      ...textBlock('x'.repeat(100)),
      ev('message_stop'),
      assembled('d1', 'x'.repeat(100)),
      result(undefined),
    ])
    const session = newSession()
    const usage = usageOf(await drain(session, 'abcdefghij'))

    for (const value of [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.totalTokens]) {
      expect(Number.isInteger(value), String(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
    }
    expect(usage.totalTokens).toBe(usage.inputTokens + usage.outputTokens)
    session.close()
  })
})
