/**
 * Which model a request runs on, and which model it is *billed* as.
 *
 * These are two different things in qodercli, and the bridge only ever set the
 * first one:
 *
 * - The **answering** model comes from `get_model_policy`, which the CLI sends
 *   before every LLM call. Overriding it there changes the model that produces
 *   the tokens.
 * - The **billed** model comes from `config.getModel()` — the `model` the
 *   session was started with — and is written onto each request as
 *   `businessModelKey`. It never consults the per-call answer.
 *
 * Because `options.model` was never passed, a session ran on the CLI's default
 * (`auto`) while every inference was overridden to `dfmodel`. The transcript
 * proves the split: every `assistant` record carries `model: dfmodel`, while
 * `runtime-config` carries `model: auto` and each `user` record carries
 * `businessModelKey: auto`. The provider's usage page reads the latter, so it
 * showed one DeepSeek-Flash request followed by a run of Auto.
 *
 * The tests below pin the three things that keep the two in step: the session
 * model is handed to the CLI, a model switch restarts the session (the value is
 * read once, at spawn), and the per-call policy stays out of the CLI's internal
 * work so those requests are attributed to whatever actually served them.
 */
import { describe, expect, it, vi } from 'vitest'

/** What the session handed to the SDK's `query()`. */
const captured = vi.hoisted(() => {
  const state: {
    resolveModel: ((request?: { purpose?: string }) => unknown) | null
    timeoutMs: number | undefined
    model: string | undefined
  } = { resolveModel: null, timeoutMs: undefined, model: undefined }
  return state
})

/** The live query's frame sink, installed when the fake `query()` runs. */
const live = vi.hoisted(() => {
  const state: {
    deliver: ((message: unknown) => void) | null
    outbox: unknown[]
    closed: boolean
    wake: (() => void) | null
  } = { deliver: null, outbox: [], closed: false, wake: null }
  return state
})

vi.mock('../src/sdk.ts', () => ({
  isDaemonConflict: () => false,
  resetSdk: () => {},
  resetDaemon: async () => {},
  cliOptions: () => ({}),
  probeDaemon: async () => {},
  loadSdk: async () => ({
    qodercliAuth: () => ({ type: 'oauth' }),
    query: ({ options }: any) => {
      captured.resolveModel = options.resolveModel
      captured.timeoutMs = options.resolveModelTimeoutMs
      captured.model = options.model
      const queue: unknown[] = []
      const wake = (): void => {
        const settle = live.wake
        live.wake = null
        settle?.()
      }
      const sink = (message: unknown): void => {
        queue.push(message)
        wake()
      }
      live.deliver = sink
      for (const buffered of live.outbox.splice(0)) sink(buffered)
      return {
        [Symbol.asyncIterator](): AsyncIterator<unknown> {
          return {
            async next(): Promise<IteratorResult<unknown>> {
              while (true) {
                if (queue.length > 0) return { done: false, value: queue.shift() }
                if (live.closed) return { done: true, value: undefined }
                await new Promise<void>(resolve => { live.wake = resolve })
              }
            },
          }
        },
        interrupt: async () => {},
        close: async () => {
          live.closed = true
          wake()
        },
      }
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

/** Reset the live query state so each test starts on a quiet process. */
function resetLive(): void {
  captured.resolveModel = null
  captured.timeoutMs = undefined
  captured.model = undefined
  live.deliver = null
  live.outbox = []
  live.closed = false
  live.wake = null
}

/** Frames a real successful turn produces, buffered before the consumer exists. */
function queueTurn(): void {
  live.outbox.push(
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } } },
    { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
  )
}

/** Run one turn so the session spawns, then hand the session back. */
async function spawn(
  model: string,
  policy: { reasoningEffort?: string, contextWindow?: number } = {},
): Promise<InstanceType<typeof QoderSession>> {
  resetLive()
  const session = new QoderSession('q-policy', model)
  session.setModel(model, policy)
  queueTurn()
  for await (const _ of session.stream({ messages: [], model } as any, 'hi')) { /* drain */ }
  return session
}

describe('session model', () => {
  it('hands the session model to the CLI, which is what requests are billed under', async () => {
    const session = await spawn('dfmodel')
    // qodercli writes `businessModelKey: config.getModel()` onto every request
    // and the provider bills from that key. Passing only the per-call policy
    // made the transcript say `dfmodel` while the usage page said `auto`.
    expect(captured.model).toBe('dfmodel')
    session.close()
  })

  it('reports a model switch so the adapter rebuilds the session', async () => {
    const session = await spawn('dfmodel')
    // The model is read once, at spawn, so an in-place switch cannot change the
    // billing key. The adapter answers this by rebuilding the session.
    expect(session.needsRestartForModel()).toBe(false)
    session.setModel('dmodel')
    expect(session.needsRestartForModel()).toBe(true)
    session.close()
  })

  it('does not ask for a restart before the process exists', async () => {
    resetLive()
    const session = new QoderSession('q-cold', 'dfmodel')
    session.setModel('dfmodel')
    // Nothing has spawned, so the set model is simply what the process will
    // read when it does — a restart here would throw away a session that has
    // not been created yet.
    expect(session.needsRestartForModel()).toBe(false)
    session.close()
  })
})

describe('per-request model policy', () => {
  it('pins the main conversation to the user’s model', async () => {
    const session = await spawn('dfmodel')
    expect(captured.resolveModel?.({ purpose: 'main' })).toMatchObject({ model: 'dfmodel' })
    session.close()
  })

  it('leaves the model alone when the CLI does not name a purpose', async () => {
    // Older CLI builds omit `purpose`. Pinning is the safe reading: the request
    // is most likely the main turn, and an unpinned main turn is the bug.
    const session = await spawn('dfmodel')
    expect(captured.resolveModel?.()).toMatchObject({ model: 'dfmodel' })
    expect(captured.resolveModel?.({})).toMatchObject({ model: 'dfmodel' })
    session.close()
  })

  it('does not override the model for the CLI’s own internal work', async () => {
    const session = await spawn('dfmodel')
    // The full `QoderModelPurpose` list minus `main`. These have their own
    // routing; forcing the conversation's model onto them only made the CLI
    // discard the answer and fall back to its default.
    for (const purpose of [
      'plan', 'task', 'compact', 'title', 'suggestion', 'generate',
      'hook_prompt', 'subagent', 'web_fetch', 'image_gen', 'compression', 'utility',
    ]) {
      expect(captured.resolveModel?.({ purpose }), purpose).toEqual({})
    }
    session.close()
  })

  it('carries the reasoning effort and window on the pinned request only', async () => {
    const session = await spawn('dfmodel', { reasoningEffort: 'high', contextWindow: 1_000_000 })
    expect(captured.resolveModel?.({ purpose: 'main' })).toEqual({
      model: 'dfmodel',
      parameters: { reasoningEffort: 'high', contextWindow: 1_000_000 },
    })
    // They describe the main route; asserting them on an internal request is
    // the same wrong override as pinning its model.
    expect(captured.resolveModel?.({ purpose: 'compact' })).toEqual({})
    session.close()
  })

  it('gives the callback more than the SDK’s 500 ms default', async () => {
    const session = await spawn('dfmodel')
    // A timeout is not a retry — it lands on the CLI's own fallback — and the
    // expensive purposes fire while the turn is at its busiest.
    expect(captured.timeoutMs).toBe(5_000)
    session.close()
  })
})
