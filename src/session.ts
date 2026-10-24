/**
 * One long-lived inner Qoder CLI session per host session id: a channel-fed
 * `query()` subprocess whose model continuation streams out as harness
 * `StreamChunk`s. Host tool calls travel through an in-process MCP server:
 * the handler parks on a promise, the adapter finishes the turn with
 * `tool-calls`, and the next host request (carrying tool results) resolves
 * the parked promise so the inner model continues with the result in place.
 * @module dsh-llm-qoder/session
 */

import { randomUUID } from 'node:crypto'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, LlmError, QUOTA_EXCEEDED_CODE, ToolCallId,
  isContextWindowExceededError, isQuotaExceededError, textOnlyImageText,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock, FinishReason, GenerateOptions, RequestMessage, StreamChunk, ToolSchema, TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { createSdkMcpServer, qodercliAuth } from '@qodercn-ai/qodercn-agent-sdk'
import type { CanUseTool, Query } from '@qodercn-ai/qodercn-agent-sdk'
import type { QoderBrand } from './brand.ts'
import { cliConflictMessage, foreignCliOverride, qoderCliOptions } from './cli.ts'
import { jsonSchemaToShape } from './jsonschema.ts'
import type { Live } from './live.ts'
import { readLive } from './live.ts'
import { feedImageRefs, feedTextLength, feedWideCharCount, renderInitialFeed } from './render.ts'
import { loadSdk } from './sdk.ts'
import { TurnOutputAccounting, estimateTextTokens } from './tokens.ts'

/** MCP server name this adapter exposes host tools under. */
export const MCP_SERVER_NAME = 'dsh-host'
/** Prefix qodercli uses for this server's tools inside `canUseTool`. */
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`

/**
 * How long a handler the CLI never announced waits for a result before failing.
 *
 * Paired handlers are settled by the host request that follows them, not by
 * this deadline: a host tool may legitimately run far longer than two minutes,
 * and a wall clock cannot tell a slow tool from a lost call.
 */
const DEFAULT_TOOL_RESULT_TIMEOUT_MS = 120_000
/** How long the inner process gets to acknowledge an abort before the turn is force-ended. */
const DEFAULT_ABORT_GRACE_MS = 5_000
/** Warm sessions kept alive when the deployment names no cap. */
export const DEFAULT_MAX_SESSIONS = 8
/** Inner turns allowed for one side-channel (title, compaction) request. */
const DEFAULT_COLD_MAX_TURNS = 4

/**
 * One content block as the assistant message actually carries it.
 *
 * The SDK's declared content type names only `text`, but the wire carries the
 * full block shape, including the `tool_use` blocks a tool-heavy turn spends
 * most of its output on. This is the local view used to read them.
 */
interface WireContentBlock {
  type?: string
  text?: string
  name?: string
  input?: unknown
}

/**
 * Runtime knobs shared by every warm session a manager owns. Populated from the
 * plugin's resolved config, so the settings page is the single place these are
 * decided.
 *
 * Each value may be a {@link Live} thunk and is resolved when a session is
 * created, not when the manager is: a settings edit therefore applies to the
 * sessions opened after it, while a conversation already in flight keeps the
 * knobs it started with.
 */
export interface SessionRuntimeOptions {
  /** How long an unpaired MCP tool handler waits before failing its call. */
  toolResultTimeoutMs?: Live<number>
  /** How long the inner process gets to acknowledge an abort. */
  abortGraceMs?: Live<number>
  /** Which edition's SDK and CLI this session speaks to. */
  brand?: QoderBrand
}

/** Per-request model policy a warm session runs with. */
export interface SessionModelPolicy {
  reasoningEffort?: string
  /**
   * The window the route publishes to the harness, and the one the CLI is asked
   * to run with.
   */
  contextWindow?: number
  /**
   * The window the CLI will *actually* run with, when that differs from the
   * declared one because the model does not advertise it. The CLI measures its
   * context ratio against this, so it is the only honest multiplier for that
   * ratio — see {@link QoderSession.usage}.
   */
  cliContextWindow?: number
}

/**
 * One user-turn content block on the streaming-input channel. Text is the
 * historical shape; image blocks use the SDK's Claude-compatible base64
 * vision shape (`ImageContentBlock`).
 */
export type ChannelContent =
  | { type: 'text', text: string }
  | { type: 'image', source: { type: 'base64', media_type: string, data: string } }

/** One MCP tool-result content block: text, or the MCP image shape. */
export type McpContent =
  | { type: 'text', text: string }
  | { type: 'image', data: string, mimeType: string }

/** A host tool result delivered to a parked or buffered MCP handler. */
export interface ToolResultPayload {
  content: McpContent[]
  isError: boolean
}

/**
 * Request-image bytes resolved by the adapter, keyed by attachment id. An id
 * missing from the map degrades to handle text instead of failing the turn.
 */
export type ResolvedImages = ReadonlyMap<string, { data: string, mediaType: string }>

interface ChannelMessage {
  type: 'user'
  message: { role: 'user', content: ChannelContent[] }
  parent_tool_use_id: null
}

/** Minimal push-only async channel feeding the SDK's streaming-input mode. */
function createChannel(): AsyncIterable<ChannelMessage> & { push(message: ChannelMessage): void } {
  const queue: ChannelMessage[] = []
  let resolve: ((result: IteratorResult<ChannelMessage>) => void) | null = null
  return {
    push(message: ChannelMessage): void {
      if (resolve !== null) {
        const settle = resolve
        resolve = null
        settle({ value: message, done: false })
      } else {
        queue.push(message)
      }
    },
    [Symbol.asyncIterator](): AsyncIterator<ChannelMessage> {
      return {
        next(): Promise<IteratorResult<ChannelMessage>> {
          const message = queue.shift()
          if (message !== undefined) return Promise.resolve({ value: message, done: false })
          return new Promise(settle => { resolve = settle })
        },
      }
    },
  }
}

type QueueItem =
  | { kind: 'chunk', chunk: StreamChunk }
  | { kind: 'turn-end', reason: FinishReason, usage?: TokenUsage }

/** Unbounded FIFO the consumer pushes into and the active turn pumps out. */
class TurnQueue implements AsyncIterable<QueueItem> {
  private readonly items: QueueItem[] = []
  private resolve: ((result: IteratorResult<QueueItem>) => void) | null = null
  private closed = false

  push(item: QueueItem): void {
    if (this.closed) return
    if (this.resolve !== null) {
      const settle = this.resolve
      this.resolve = null
      settle({ value: item, done: false })
    } else {
      this.items.push(item)
    }
  }

  close(): void {
    this.closed = true
    if (this.resolve !== null) {
      const settle = this.resolve
      this.resolve = null
      settle({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<QueueItem> {
    return {
      next: (): Promise<IteratorResult<QueueItem>> => {
        const item = this.items.shift()
        if (item !== undefined) return Promise.resolve({ value: item, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise(settle => { this.resolve = settle })
      },
    }
  }

  /** Whether the turn already ended; late pushes are dropped. */
  get isClosed(): boolean {
    return this.closed
  }
}

interface ParkedResolver { (result: ToolResultPayload): void }

/** One tool-use block under assembly in the active turn. */
interface ToolUnderAssembly {
  chunkIndex: number
  callId: string
  name: string
  arguments: string
}

/**
 * Structural view of the SDK usage this consumer forwards to the harness.
 *
 * Every field is optional because the CLI zeroes the four token counters unless
 * it was started with the switch in `cli.ts`; `credits` and the context ratio
 * survive either way. {@link meteredUsage} decides what is real.
 */
export interface SdkUsage {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  /** The CLI's own measurement of how full this session's context is. */
  context_usage_ratio?: number | null
}

/** Structural view of the SDK stream events this consumer cares about. */
interface SdkStreamEvent {
  type: string
  content_block?: { type?: string, id?: string, name?: string, input?: unknown }
  delta?: { type?: string, text?: string, thinking?: string, partial_json?: string }
  usage?: SdkUsage
  message?: { content?: unknown, usage?: SdkUsage }
}

/** The frame fields the request-usage sampler reads. */
export interface UsageFrame {
  type: string
  event?: SdkStreamEvent
  usage?: SdkUsage
}

/** Structural view of the SDK messages this consumer cares about. */
interface SdkMessage extends UsageFrame {
  subtype?: string
  message?: { content?: Array<{ type?: string, text?: string }>, usage?: SdkUsage }
  errors?: unknown
}

/**
 * Whether a usage record carries real metering rather than the CLI's zero filler.
 *
 * The CLI attaches a usage record to several frames and leaves the four token
 * counters at zero on all but one kind; a real request always consumed a prompt
 * and produced output, so at least one counter being positive is the whole test.
 */
export function carriesTokens(usage: SdkUsage): boolean {
  const positive = (value: number | null | undefined): boolean => typeof value === 'number' && value > 0
  return positive(usage.input_tokens) || positive(usage.output_tokens)
    || positive(usage.cache_read_input_tokens) || positive(usage.cache_creation_input_tokens)
}

/**
 * The occupancy sample one arriving frame may contribute, if any.
 *
 * Exactly one carrier may: the `message_delta` emitted when a provider request
 * finishes, whose usage describes that request's prompt — which is precisely
 * what context occupancy means. The other carriers are traps, confirmed against
 * a live CLI with a tool the inner model calls four times in one turn:
 *
 *  - `message_start`, and the assembled `assistant` message, report all four
 *    counters as zero; a request's numbers exist only once it finishes.
 *  - the `result` frame reports the WHOLE inner turn's total, summed over every
 *    provider request that turn made. One host step is one request, but an inner
 *    turn ends only when the model stops calling tools, so a long agentic run
 *    reports a multiple of any real prompt — that four-request turn ended at
 *    `input_tokens` 2 921 where each request had used 608–837. Taking that total
 *    as the session's occupancy pegged the harness context meter at 100%
 *    (9.8M against a 1M window) and latched it there.
 *
 * @param message - one arriving SDK message.
 * @returns the usage to sample, or undefined when this frame may not supply one.
 */
export function requestUsageSample(message: UsageFrame): SdkUsage | undefined {
  if (message.type !== 'stream_event') return undefined
  const usage = message.event?.usage ?? message.event?.message?.usage
  return usage !== undefined && carriesTokens(usage) ? usage : undefined
}

/**
 * One frame's own metering, translated into the harness's token buckets.
 *
 * Three rules, each measured against a live CLI rather than inferred:
 *
 * 1. `input_tokens` IS the whole prompt, cache included. The CLI measures its
 *    `context_usage_ratio` as `input_tokens / window` (a probe: 9 811 input at
 *    a 200 000 window → exactly 0.049055) and subtracts the cached part
 *    afterwards for its own telemetry — so the harness's four buckets, which
 *    are disjoint, have to take both cache halves back out of `inputTokens`.
 * 2. Both cache buckets are always reported, zero included. The harness shows a
 *    turn's usage only when its accounting is complete: a missing cache bucket
 *    with no `totalTokens` to prove the sum makes the whole disclosure
 *    unavailable, so omitting a zero would hide every per-turn usage row.
 * 3. `totalTokens` is the sum of the four buckets, so the harness's
 *    consistency check (`total - output == input + cacheRead + cacheWrite`)
 *    holds by construction.
 *
 * @param real - the CLI's usage frame, or undefined when it reported none.
 * @param reasoning - the local reasoning estimate, clamped inside the provider's
 *   own output total (the harness drops a reading whose reasoning exceeds it).
 * @returns the harness usage, or undefined when the frame carries no metering.
 */
export function meteredUsage(
  real: SdkUsage | undefined,
  reasoning: (meteredOutput: number) => { reasoningTokens?: number },
): TokenUsage | undefined {
  if (real === undefined
    || typeof real.input_tokens !== 'number'
    || typeof real.output_tokens !== 'number'
    || (real.input_tokens <= 0 && real.output_tokens <= 0)) return undefined
  const cacheReadTokens = typeof real.cache_read_input_tokens === 'number' ? real.cache_read_input_tokens : 0
  const cacheWriteTokens = typeof real.cache_creation_input_tokens === 'number' ? real.cache_creation_input_tokens : 0
  const inputTokens = Math.max(0, real.input_tokens - cacheReadTokens - cacheWriteTokens)
  const outputTokens = real.output_tokens
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens,
    ...reasoning(outputTokens),
  }
}

/**
 * The host tool runtime dispatches by the bare host name; the inner model
 * only ever sees the namespaced MCP form, so strip the prefix on the way out.
 */
export function hostToolName(name: string): string {
  return name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name
}

/** Deny native tools, allow this adapter's MCP tools. */
export async function gateTools(toolName: string, _input: unknown, options: { toolUseID?: string }): Promise<unknown> {
  const echo = options.toolUseID !== undefined ? { toolUseID: options.toolUseID } : {}
  if (toolName.startsWith(MCP_TOOL_PREFIX)) return { behavior: 'allow', ...echo }
  return {
    behavior: 'deny',
    message: '本会话是宿主 agent 的 LLM 后端，不直接执行工具。宿主的工具已通过 MCP 挂入，直接调用它们即可。',
    ...echo,
  }
}

/** Message the inner model reads when a host turn superseded a parked call. */
const SUPERSEDED_CALL_TEXT = '[宿主取消了这次工具执行]'

/** Payload for a call the host request that followed it did not answer. */
function unansweredCall(toolUseId: string): ToolResultPayload {
  return {
    content: [{
      type: 'text',
      text: `宿主未返回这次工具调用的结果（toolUseId=${toolUseId}），本次工具调用已取消`,
    }],
    isError: true,
  }
}

/**
 * The tool-result bridge between the inner CLI and the host.
 *
 * qodercli announces a tool call twice, under two different identities:
 * `canUseTool` receives the CLI's own tool-use id *before* the call runs, while
 * the MCP `tools/call` handler that actually needs the host's result receives no
 * id at all. The two arrive in the same order, so a FIFO pairs them — and the
 * handler then parks under the exact id the host's result was filed under.
 *
 * ## Why that FIFO belongs to the session, not to a turn
 *
 * Measured against a live CLI, the handler can fire *after* the turn it belongs
 * to has already ended. The host answers a tool call as soon as it sees the
 * block, so the adapter's `deliverToolResults` files the result while nothing is
 * parked yet, and only then does the CLI get around to dispatching the MCP call:
 *
 * ```
 * 6198ms  [endTurn] kind=tool-calls
 * 6198ms  [host] no parked handler -> BUFFERED under key=call_80d292a7…
 * 6217ms  [mcp handler] ENTER | shifted toolUseId=undefined
 * 6217ms  [mcp handler] PARKING under key=anonymous-1
 * 14226ms [mcp handler] TIMED OUT after 8009ms
 * ```
 *
 * Clearing the announcements at the turn boundary therefore threw away the very
 * id the handler was about to claim. The handler fell through to a fallback key
 * nothing could resolve, parked for the whole tool-result timeout, and the turn
 * stalled — 120 s by default, which the user reads as "the model stopped
 * answering" and works around by stopping the conversation and resending. The
 * stall is probabilistic because a *slow* host tool (a shell command) parks its
 * handler before the turn ends and takes the other path, while a fast one
 * (`read`, `ask_user_question`) loses the race.
 *
 * ## Why a parked call must not have a wall-clock deadline
 *
 * A host result can only arrive on the next host request: the host runs every
 * tool of the round first, then sends one request carrying all their results.
 * A host tool is allowed to run for minutes (a build, a directory scan, a long
 * shell command), and one slow tool delays the results of its whole batch. A
 * fixed 120 s deadline therefore cancels calls whose real result is still on
 * its way:
 *
 * ```
 * 10:07:53  [mcp handler] PARK call_00_QFqbaum… (write — result ready at once)
 * 10:07:53  [host]         pwsh starts (its own timeout: 300 s)
 * 10:09:53  [mcp handler] TIMED OUT after 120s   <- write cancelled for nothing
 * 10:10:38  [host]         first request arrives with all three results
 * ```
 *
 * The request boundary is the real signal: the request that continues a tool
 * round carries a result for every call the host answered; a call it did not
 * answer in that request will never be answered. {@link beginHostRequest}
 * settles those, so a slow host never loses a result it was about to send.
 * Only a handler with no announced id — where no result can be matched at all
 * — keeps a bounded park as the last-resort recovery.
 *
 * ## Why the boundary alone is not enough
 *
 * The boundary settles what is *already* parked when it runs, and an
 * announcement that arrives after it is not touched by it. That leaves one
 * shape a wall clock used to break and nothing else could: the CLI dispatches
 * an MCP call whose tool-use block never reached the host. No result can be
 * filed for that id, and the boundary that would settle it needs the next host
 * request — which needs this turn to end first, and this turn is blocked on the
 * handler. The turn hangs until the user stops it. {@link claim} therefore
 * checks {@link ToolResultPairing.hostVisible} before parking: a call the host
 * was never shown fails at once, exactly as the boundary would have failed it.
 *
 * Announcements are dropped only where the CLI provably cancels its pending
 * dispatch — {@link forgetUnclaimed} on an aborted or failed turn, and
 * {@link clear} when the session dies.
 */
export class ToolResultPairing {
  /** Handlers parked under the tool-use id their host result will arrive as. */
  private readonly parked = new Map<string, ParkedResolver>()
  /** Results that arrived before their handler did, by tool-use id. */
  private readonly buffered = new Map<string, ToolResultPayload>()
  /** Tool-use ids `canUseTool` allowed, in execution order, awaiting a handler. */
  private readonly announced: string[] = []
  /**
   * Announcements a host request has moved past without answering.
   *
   * A handler for one of these can still fire (the CLI decides when to dispatch
   * the MCP call), but no result will ever arrive for it; {@link claim} settles
   * it immediately instead of parking it for the fallback timeout.
   */
  private readonly abandoned: string[] = []
  /**
   * Host callId (`qoder-N`) → qodercli tool-use id, from the content-block ids.
   *
   * Keyed by a per-session nonce, so a stale entry can never be reached by a
   * later call and is safe to keep across turns; it is dropped with the session.
   */
  private readonly hostCallIds = new Map<string, string>()
  /**
   * Tool-use ids the host was actually shown, and has not answered yet.
   *
   * A host result is filed under a tool-use id only because the adapter emitted
   * that call's block to the host, so these — and only these — are calls the
   * host can still answer. {@link claim} refuses to park on any other id; see
   * the deadlock it prevents there. Mirrors the values of {@link hostCallIds}
   * and is cleared everywhere that map is.
   */
  private readonly hostVisible = new Set<string>()
  /** Suffix for a handler that claimed no announcement, so keys stay distinct. */
  private anonymous = 0

  /** Record the tool-use id `canUseTool` allowed, in execution order. */
  announce(toolUseId: string): void {
    this.announced.push(toolUseId)
  }

  /** Record which tool-use id a model-emitted tool-call block belongs to. */
  mapHostCall(hostCallId: string, toolUseId: string): void {
    this.hostCallIds.set(hostCallId, toolUseId)
    this.hostVisible.add(toolUseId)
  }

  /**
   * Hand one MCP handler the result the host already delivered, or park it until
   * the host delivers one.
   *
   * A paired call is NOT timed out. The host can only answer on its next
   * request, and a host tool may legitimately run for minutes; the next request
   * settles it instead — see {@link beginHostRequest}. `timeoutMs` is therefore
   * reached only by a handler the CLI never announced, where no id exists to
   * match a result against and a bounded park remains the last resort.
   *
   * Parking forever is safe only for a call the host was shown; an announced id
   * the host never received fails at once rather than hanging the turn. See the
   * measurement in the body.
   *
   * @param timeoutMs - how long an *unpaired* handler waits before failing.
   * @returns the host's result, a cancellation, or a timeout payload.
   */
  async claim(timeoutMs: number): Promise<ToolResultPayload> {
    const toolUseId = this.announced.shift()
    if (toolUseId !== undefined) {
      const ready = this.buffered.get(toolUseId)
      if (ready !== undefined) {
        this.buffered.delete(toolUseId)
        return ready
      }
      // An announcement says only that the CLI allowed a call; it does not prove
      // the host ever saw it. A block that arrives while no host request is open
      // is dropped by the session, yet the CLI still dispatches its MCP message
      // — measured on a turn whose model asked for a host tool by its bare name,
      // was refused by the CLI's own scheduler, and retried 105 s later with the
      // qualified name: that retry's block landed 26 ms before the next host
      // request opened, so nothing was emitted to the host, and parking on it
      // hung the turn for 572 s until the user stopped it.
      //
      // Nothing can end that wait: a result arrives only on a host request, the
      // next host request cannot be sent until this turn finishes, and this turn
      // cannot finish while the handler is parked. So a call the host was never
      // shown fails now, with the same cancellation the request boundary would
      // have produced one round later.
      if (!this.hostVisible.has(toolUseId)) return unansweredCall(toolUseId)
      return await this.park(toolUseId)
    }
    const abandoned = this.abandoned.shift()
    if (abandoned !== undefined) return unansweredCall(abandoned)
    // No announcement: the CLI dispatched a call whose permission ask never
    // reached this pairing. With nothing else parked, a single unclaimed
    // result is the only unambiguous match; anything else falls through to the
    // bounded anonymous park.
    if (this.parked.size === 0 && this.buffered.size === 1) {
      const only = this.buffered.entries().next()
      if (only.done !== true) {
        this.buffered.delete(only.value[0])
        return only.value[1]
      }
    }
    return await this.park(`anonymous-${++this.anonymous}`, timeoutMs)
  }

  /**
   * Park one handler under `key` until the host answers, the request boundary
   * settles it, or — for an unpaired key only — the fallback timeout expires.
   */
  private async park(key: string, timeoutMs?: number): Promise<ToolResultPayload> {
    return await new Promise<ToolResultPayload>(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined
      if (timeoutMs !== undefined) {
        // An id the host never answers must not leave the inner process waiting
        // forever, or qodercli's loop deadlocks instead of recovering.
        timer = setTimeout(() => {
          this.parked.delete(key)
          resolve({
            content: [{
              type: 'text',
              text: `宿主在 ${timeoutMs / 1000}s 内未返回工具结果（toolUseId=${key}），本次工具调用已取消`,
            }],
            isError: true,
          })
        }, timeoutMs)
      }
      this.parked.set(key, payload => {
        if (timer !== undefined) clearTimeout(timer)
        resolve(payload)
      })
    })
  }

  /**
   * File one host tool result against the call it answers.
   *
   * Resolves the handler already parked under that tool-use id, or buffers the
   * result for the handler that has not fired yet — which is the ordinary case
   * for a host tool that returns quickly.
   *
   * @param hostCallId - the host-facing call id from the tool-result message.
   * @param payload - the rendered result.
   * @returns the tool-use id the result was filed under, for the request
   *   boundary that settles the rest of the round.
   */
  deliver(hostCallId: string, payload: ToolResultPayload): string {
    // Without a mapping (a call the host never surfaced) the callId is used as
    // the key, so the entry still buffers for any handler that parked under it.
    const key = this.hostCallIds.get(hostCallId) ?? hostCallId
    // A host call id is answered once; keeping the mapping would only retain
    // one string per tool call for the life of the session.
    this.hostCallIds.delete(hostCallId)
    this.hostVisible.delete(key)
    const resolve = this.parked.get(key)
    if (resolve !== undefined) {
      this.parked.delete(key)
      resolve(payload)
      return key
    }
    this.buffered.set(key, payload)
    return key
  }

  /**
   * Settle the pairing against one arriving host request.
   *
   * The host runs every tool of a round before it sends the request that
   * continues the conversation, and that request carries a result for every
   * call it answered. A call it did not answer there will never be answered,
   * so this boundary — not a wall clock — decides that a handler is stranded:
   *
   *  - a handler parked under an unanswered id is released now;
   *  - an announcement whose handler has not fired yet is marked abandoned, so
   *    that handler settles as soon as it does arrive;
   *  - a buffered result from an earlier round whose handler never arrived is
   *    dropped, because no later request can produce that handler.
   *
   * A fresh user turn is handled by the same rules: the results the request
   * still carries are delivered, and the calls it left unanswered are
   * superseded. It differs only in the cancellation text the model reads.
   *
   * `delivered` is what protects the fast-handler race: a result can arrive
   * before the CLI dispatches the MCP handler, and a runtime-context snapshot
   * can make the same request look like a new user turn. Keeping everything
   * this request answered, in both cases, is what lets that handler collect
   * the real result instead of a cancellation.
   *
   * @param delivered - tool-use ids the host just delivered a result for.
   * @param freshUserTurn - whether the request carries a new user message.
   */
  beginHostRequest(delivered: ReadonlySet<string>, freshUserTurn: boolean): void {
    // Nothing is outstanding, so no handler can still arrive for an older
    // abandoned id; the next one must belong to the round this request starts.
    if (this.announced.length === 0 && this.parked.size === 0) this.abandoned.length = 0
    for (const [key, resolve] of [...this.parked.entries()]) {
      if (delivered.has(key)) continue
      this.parked.delete(key)
      resolve(freshUserTurn
        ? { content: [{ type: 'text', text: SUPERSEDED_CALL_TEXT }], isError: true }
        : unansweredCall(key))
    }
    const kept = this.announced.filter(id => delivered.has(id))
    for (const id of this.announced) {
      if (!delivered.has(id)) this.abandoned.push(id)
    }
    this.announced.length = 0
    this.announced.push(...kept)
    for (const key of [...this.buffered.keys()]) {
      if (!delivered.has(key)) this.buffered.delete(key)
    }
    this.hostCallIds.clear()
    this.hostVisible.clear()
  }

  /**
   * Release every parked handler: the host started a fresh user turn while their
   * calls were still outstanding, so those calls can never be answered.
   */
  cancelParked(): void {
    const stale = [...this.parked.entries()]
    this.parked.clear()
    for (const [, resolve] of stale) {
      resolve({ content: [{ type: 'text', text: SUPERSEDED_CALL_TEXT }], isError: true })
    }
  }

  /**
   * Drop announcements no handler can still claim, and release parked handlers.
   *
   * An aborted or failed turn is one where the CLI cancels its pending tool
   * dispatch, so an id it announced but never dispatched would otherwise shift
   * the pairing of the NEXT turn's handler by one slot and park it under a key
   * nothing resolves — reintroducing the very stall this class exists to fix.
   * A handler that was already dispatched still needs an answer, so parked
   * handlers settle here, and announcements move to the abandoned queue in case
   * their dispatch was already in flight when the turn died.
   */
  forgetUnclaimed(): void {
    this.abandoned.push(...this.announced)
    this.announced.length = 0
    this.cancelParked()
    this.buffered.clear()
    this.hostCallIds.clear()
    this.hostVisible.clear()
  }

  /** Drop all pairing state; the session is being torn down. */
  clear(): void {
    // Release before discarding, so a handler that is still parked settles
    // rather than holding a promise nothing can ever resolve.
    this.cancelParked()
    this.announced.length = 0
    this.abandoned.length = 0
    this.hostCallIds.clear()
    this.hostVisible.clear()
    this.buffered.clear()
  }

  /** How many handlers are waiting for a host result. */
  get parkedCount(): number {
    return this.parked.size
  }
}

/** The SDK permission callback shape this adapter implements per session. */
type SessionCanUseTool = (toolName: string, input: Record<string, unknown>, options: { toolUseID?: string }) => Promise<unknown>

/**
 * One warm inner session. All mutation happens on the consumer fiber except
 * the documented turn lifecycle driven by {@link stream}.
 */
export class QoderSession {
  private readonly channel = createChannel()
  /**
   * Lazy: the MCP SDK refuses tool registration after the transport connects,
   * so the inner process only spawns once {@link ensureTools} has registered
   * the host tools (the adapter does that immediately before each stream).
   */
  private q: Query | null = null
  /**
   * Tool-result pairing state. Owned by the session rather than the turn,
   * because a handler can fire after its turn has ended — see
   * {@link ToolResultPairing} for the measurement that proves it.
   */
  private readonly pairing = new ToolResultPairing()
  private readonly mcp = createSdkMcpServer({ name: MCP_SERVER_NAME, tools: [] })
  private readonly registered = new Map<string, string>()
  private queue: TurnQueue | null = null
  private model: string
  private reasoningEffort: string | undefined
  private callCounter = 0
  /**
   * Per-instance suffix for emitted host call ids. Ids must stay unique across
   * the whole host session log: a history divergence rebuilds this class, LRU
   * eviction recreates it, and the harness keys tool-call blocks by id, so a
   * fresh `qoder-1` would collide with the one its predecessor already stored.
   */
  private readonly callNonce = randomUUID().slice(0, 8)
  private abortPending = false
  private disposed = false
  /**
   * How the active turn ended, so its cleanup can tell a completed turn (whose
   * unclaimed announcements may still belong to a handler about to fire) from an
   * aborted or failed one (where the CLI cancelled that dispatch).
   */
  private turnEndKind: FinishReason['kind'] | undefined = undefined
  /** Previous request's messages for delta feeding. */
  fedMessages: readonly RequestMessage[] | undefined
  fedSystem: string | undefined
  /** This turn's fed characters, reset per turn for per-call token accounting. */
  turnInputChars = 0
  /** Host system prompt captured before spawn for the boot-time systemPrompt. */
  private hostSystem: string | undefined
  /** Host session workspace; qodercli runs there so its preset reports the session cwd. */
  private sessionCwd: string | undefined

  // Active-turn assembly state, touched only by the consumer fiber.
  private blockIndex = 0
  private textBlock: { index: number, text: string } | undefined
  private reasoningBlock: { index: number, text: string } | undefined
  private openTool: ToolUnderAssembly | undefined
  private toolCalls: ToolUnderAssembly[] = []
  /**
   * This turn's generated output, priced by script.
   *
   * Counts visible text, reasoning, and tool-call names and arguments — see
   * {@link TurnOutputAccounting} for why the last one matters.
   */
  private readonly output = new TurnOutputAccounting()
  /**
   * Metering of the last provider request that finished in the active turn.
   *
   * Never the `result` frame's usage, which totals the whole inner turn across
   * every request it made — see {@link requestUsageSample}.
   */
  private lastUsage: SdkUsage | undefined
  /**
   * The active turn's feed as plain text, when that feed carries image bytes.
   * Kept so a CLI that refuses to decode those bytes can be retried without
   * them instead of failing the turn. Cleared with the turn.
   */
  private feedFallback: string | undefined
  /**
   * Session-level input token estimate for the CURRENT request, priced by
   * script mix over the rendered conversation the inner session actually
   * receives. It is the last-resort tier of {@link usage}: a turn whose frames
   * carry no metering at all would otherwise read ~0% on the context meter and
   * never trigger auto-compaction, and the CLI's own context ratio is preferred
   * over this whenever the turn reported one.
   */
  private estimatedInputTokens: number | undefined
  /**
   * The window this route publishes, i.e. the denominator the harness meter
   * divides by. The CLI's context ratio is turned into tokens against this same
   * number, so the meter and the ratio always describe one window.
   */
  private contextWindow: number | undefined
  /**
   * The window the CLI will actually run with, when that is known to differ
   * from {@link contextWindow} because the model does not advertise the
   * declared one. This is the denominator the CLI itself measures its context
   * ratio against, so it is what the ratio must be multiplied by.
   */
  private cliContextWindow: number | undefined

  /** Per-session runtime knobs, resolved from the plugin config at creation. */
  private readonly toolResultTimeoutMs: number
  private readonly abortGraceMs: number
  /** Which edition's CLI (and SDK) this session runs on. */
  private readonly brand: QoderBrand

  constructor(
    readonly sessionId: string,
    initialModel: string,
    runtime: SessionRuntimeOptions = {},
  ) {
    this.model = initialModel
    this.toolResultTimeoutMs = readLive(runtime.toolResultTimeoutMs, DEFAULT_TOOL_RESULT_TIMEOUT_MS)
    this.abortGraceMs = readLive(runtime.abortGraceMs, DEFAULT_ABORT_GRACE_MS)
    this.brand = runtime.brand ?? 'cn'
  }

  /** Spawn the inner process (first stream only) and attach the consumer. */
  private async ensureStarted(): Promise<Query> {
    if (this.q !== null) return this.q
    // The SDK reads QODERCLI_PATH itself before any option we pass, so a
    // foreign value must fail the turn instead of answering with the other
    // account's CLI. See `cli.ts`.
    const conflict = foreignCliOverride(this.brand)
    if (conflict !== undefined) throw new Error(cliConflictMessage(this.brand))
    // The SDK is brand-specific: the CN module speaks to qoderclicn and the
    // international one to qodercli, each against its own credentials.
    const sdk = await loadSdk(this.brand)
    const q = sdk.query({
      prompt: this.channel,
      options: {
        // Spawn the CLI instead of running its runtime in a worker thread: in
        // this process that thread's sharp fights the host's own over the
        // libvips DLL every image needs. See `cli.ts`.
        ...qoderCliOptions(this.brand),
        auth: qodercliAuth(),
        tools: [],
        allowedTools: [],
        canUseTool: this.canUseTool as CanUseTool,
        settingSources: [],
        includePartialMessages: true,
        resolveModel: () => ({
          model: this.model,
          // The window travels with the model, because it is a property of the
          // route rather than of one call. It has to be sent here: the CLI
          // measures its `context_usage_ratio` against the window it is actually
          // running with, so a deployment that declares 1M while the CLI still
          // assumes the model's own 200K gets a ratio five times too large, and
          // the meter that multiplies by the declared window inherits that error
          // exactly (see `usage()` in this file).
          ...this.reasoningEffort === undefined && this.contextWindow === undefined
            ? {}
            : {
                parameters: {
                  ...this.reasoningEffort === undefined ? {} : { reasoningEffort: this.reasoningEffort },
                  ...this.contextWindow === undefined ? {} : { contextWindow: this.contextWindow },
                },
              },
        }),
        mcpServers: { [MCP_SERVER_NAME]: this.mcp },
        allowedMcpServerNames: [MCP_SERVER_NAME],
        // Host prompt passes through verbatim: no qodercli preset, so its
        // injected workspace/environment fields never reach the model.
        ...this.hostSystem === undefined ? {} : { systemPrompt: this.hostSystem },
        ...this.sessionCwd === undefined ? {} : { cwd: this.sessionCwd },
      },
    })
    this.q = q
    void this.consume(q)
    return q
  }

  /** Point the session at a model and its per-request policy. */
  setModel(model: string, policy?: SessionModelPolicy): void {
    this.model = model
    this.reasoningEffort = policy?.reasoningEffort
    this.contextWindow = policy?.contextWindow
    this.cliContextWindow = policy?.cliContextWindow
  }

  /** Record the host system prompt; effective only before the process spawns. */
  setSystem(system: string | undefined): void {
    this.hostSystem = system
  }

  /**
   * Record the host session workspace; effective only before the process
   * spawns. qodercli inherits the host process cwd otherwise, which would
   * make its preset report the server's launch directory instead of the
   * session's workspace.
   */
  setCwd(cwd: string | undefined): void { this.sessionCwd = cwd }

  /**
   * Permission gate for the inner process. Native tools are denied; MCP host
   * tools are allowed, and each allowed call's qodercli tool-use id is recorded
   * so the matching MCP handler can park under the exact id (qodercli asks once
   * per call, in execution order, before dispatching the MCP message).
   */
  private canUseTool: SessionCanUseTool = (toolName, _input, options) => {
    if (toolName.startsWith(MCP_TOOL_PREFIX)) {
      if (options.toolUseID !== undefined) this.pairing.announce(options.toolUseID)
      return Promise.resolve({ behavior: 'allow', ...options.toolUseID === undefined ? {} : { toolUseID: options.toolUseID } })
    }
    return Promise.resolve({
      behavior: 'deny',
      message: '本会话是宿主 agent 的 LLM 后端，不直接执行工具。宿主的工具已通过 MCP 挂入，直接调用它们即可。',
      ...options.toolUseID === undefined ? {} : { toolUseID: options.toolUseID },
    })
  }

  /** Register any host tools whose schema this session's MCP server lacks. */
  ensureTools(tools: readonly ToolSchema[]): void {
    for (const schema of tools) {
      const hash = JSON.stringify(schema.parameters ?? {})
      if (this.registered.get(schema.name) === hash) continue
      const shape = jsonSchemaToShape(schema.parameters ?? {})
      try {
        this.mcp.instance.registerTool(schema.name, {
          description: schema.description.length > 0 ? schema.description : schema.name,
          inputSchema: shape,
        }, async (args: unknown): Promise<{ content: McpContent[], isError?: boolean }> => {
          void args
          const result = await this.pairing.claim(this.toolResultTimeoutMs)
          return {
            content: result.content,
            ...result.isError ? { isError: true } : {},
          }
        })
      } catch {
        // Re-registration of a changed schema failed: keep the old tool rather
        // than dropping it; nothing else can recover here.
        continue
      }
      this.registered.set(schema.name, hash)
    }
  }

  /**
   * Deliver host tool results to parked or buffered handlers, keyed by call id,
   * and settle the previous round at this request boundary.
   * @param tail - the host messages appended since the previous request.
   * @param images - adapter-resolved request images keyed by attachment id; an
   *   id missing from the map degrades to handle text.
   */
  deliverToolResults(tail: readonly RequestMessage[], images?: ResolvedImages): void {
    let freshUserTurn = false
    const delivered = new Set<string>()
    for (const message of tail) {
      if (message.role === 'user') {
        freshUserTurn = true
        continue
      }
      if (message.role !== 'tool') continue
      delivered.add(this.pairing.deliver(String(message.toolCallId), {
        content: renderResultContent(message.content, images),
        isError: message.isError === true,
      }))
    }
    // This request either answers the previous round's calls or supersedes
    // them; either way, the parked handlers must not wait for a timeout that
    // no longer exists. See {@link ToolResultPairing.beginHostRequest}.
    this.pairing.beginHostRequest(delivered, freshUserTurn)
  }

  /**
   * Run one inner turn: feed (if any) then pump consumer chunks until finish.
   * @param options - the host request (signal; tools already registered).
   * @param feed - literal text, resolved content blocks (a vision turn), or
   *   null for a pure tool-result continuation.
   * @param fallback - the same feed rendered as text. Used only if the inner
   *   CLI refuses the turn's image bytes, in which case the turn is resent
   *   without them rather than failing (see {@link retryWithoutImages}).
   */
  async *stream(
    options: GenerateOptions,
    feed: string | readonly ChannelContent[] | null,
    fallback?: string,
  ): AsyncGenerator<StreamChunk> {
    if (this.queue !== null) throw new LlmError(`qoder session ${this.sessionId} already has a turn in flight`, 'CONFLICT')
    if (this.disposed) throw new LlmError(`qoder session ${this.sessionId} was disposed`, 'TRANSPORT')
    const q = await this.ensureStarted()
    this.queue = new TurnQueue()
    this.resetTurnState()
    if (feed !== null) {
      const content: ChannelContent[] = typeof feed === 'string' ? [{ type: 'text', text: feed }] : [...feed]
      this.feedFallback = fallback !== undefined && content.some(block => block.type === 'image') ? fallback : undefined
      this.turnInputChars += contentChars(content)
      this.channel.push({
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
      })
    }
    const signal = options.signal
    let abortTimer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      this.abortPending = true
      // interrupt() rides the same transport a teardown may already have killed
      // (a host abort racing process shutdown); its rejection must not surface
      // as an unhandled promise rejection.
      void q.interrupt().catch(() => undefined)
      // Fallback: end the turn if the inner process does not settle promptly.
      abortTimer = setTimeout(() => this.endTurn({ kind: 'aborted', failure: { message: 'qoder session aborted by host', code: 'ABORTED' } }), this.abortGraceMs)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      for await (const item of this.queue) {
        if (item.kind === 'chunk') {
          yield item.chunk
          continue
        }
        if (item.usage !== undefined) {
          yield { type: 'usage', usage: this.usage() }
        }
        yield { type: 'finish', reason: item.reason }
        return
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (abortTimer !== undefined) clearTimeout(abortTimer)
      // An aborted or failed turn is one where qodercli cancels whatever tool
      // dispatch it had not yet made. Announcements it never spent would shift
      // the next turn's handler onto the wrong id, so they are dropped here —
      // see {@link ToolResultPairing.forgetUnclaimed}.
      if (this.turnEndKind === 'aborted' || this.turnEndKind === 'error') this.pairing.forgetUnclaimed()
      this.queue = null
      this.abortPending = false
      this.feedFallback = undefined
    }
  }

  /**
   * Resend the current turn without its images after the CLI refused them.
   *
   * The inner CLI decodes every image before the model sees the turn, and a
   * decode it cannot do fails that whole turn — the host would surface an error
   * for a question whose only problem was the pixels. The failed turn never
   * reached the model, so the same turn goes out again with the images replaced
   * by the harness's own handle text, the same text a text-only route renders,
   * and the user still gets an answer.
   *
   * @param detail - the failed result frame's subtype and errors.
   * @returns whether a retry was started, in which case the turn must not be
   *   ended: the retry's own result frame settles it.
   */
  private retryWithoutImages(detail: string): boolean {
    const fallback = this.feedFallback
    if (fallback === undefined || !isImageAttachFailure(detail)) return false
    // Anything already streamed belongs to a real answer this turn produced:
    // resending would duplicate it instead of replacing it.
    if (this.textBlock !== undefined || this.reasoningBlock !== undefined
      || this.toolCalls.length > 0 || this.output.outputChars > 0) return false
    this.feedFallback = undefined
    this.resetTurnState()
    this.turnInputChars += fallback.length
    this.channel.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: fallback }] },
      parent_tool_use_id: null,
    })
    return true
  }

  /** Tear the inner process down; parked calls die with it. */
  close(): void {
    if (this.disposed) return
    this.disposed = true
    // Parked handlers die with the process, but their promises must not outlive
    // it: dropping the pairing state releases anything still waiting.
    this.pairing.clear()
    if (this.q !== null) void this.q.close().catch(() => undefined)
  }

  /**
   * Reset the per-turn assembly state.
   *
   * Pairing state is deliberately NOT touched here. It looks turn-scoped, but a
   * `tools/call` handler can fire only after the turn that announced it has
   * already ended — the host answers a tool call the moment it sees the block,
   * and the CLI dispatches the MCP message some milliseconds later. Clearing
   * announcements at this boundary made that handler claim nothing, park under a
   * fallback key, and wait out the whole tool-result timeout; see
   * {@link ToolResultPairing}. {@link QoderSession.close} drops it with the
   * session, and an aborted turn drops what it can no longer claim.
   */
  private resetTurnState(): void {
    this.blockIndex = 0
    this.textBlock = undefined
    this.reasoningBlock = undefined
    this.openTool = undefined
    this.toolCalls = []
    this.turnInputChars = 0
    this.output.reset()
    this.lastUsage = undefined
    this.turnEndKind = undefined
  }

  private emit(chunk: StreamChunk): void { this.queue?.push({ kind: 'chunk', chunk }) }

  /** Count generated text toward this turn's output tokens. */
  private countOutput(text: string): void { this.output.addOutput(text) }

  /**
   * Price this turn's generated text, by script rather than at a flat rate.
   *
   * {@link TurnOutputAccounting} owns the counters and the harness invariant
   * that `reasoningTokens` is a subset of `outputTokens` — the harness discards
   * a whole reading when it is not.
   */
  private outputUsage(): { outputTokens: number, reasoningTokens?: number } {
    return this.output.usage()
  }

  private usage(): TokenUsage {
    // Two tiers, most authoritative first. The CLI's own metering is now
    // available, because the child is started with the switch that keeps it from
    // zeroing the counters on the way out (`cli.ts`) — including the cache
    // buckets, which is the only thing that can make `缓存命中` mean anything.
    const metered = meteredUsage(this.lastUsage, output => this.output.reasoningTokensWithin(output))
    if (metered !== undefined) return metered
    // Below this line the turn carried no usable metering at all: a CLI build
    // that predates the switch, the in-process worker transport that cannot be
    // handed an environment, or a turn that died before its result frame.
    //
    // Such a session still reports how full its context is, and that ratio comes
    // from the inner model's own tokenizer. It is a fraction of the window the
    // CLI is RUNNING with, which is not always the window this plugin declared:
    // the CLI only honours a window the model advertises, and silently keeps its
    // own default otherwise. Multiplying by the declared window in that case
    // inflates every reading by the ratio of the two (5x for a 1M override on a
    // 200K-only model), so prefer the window the CLI actually uses and fall back
    // to the declared one only when the catalog could not tell us.
    const ratioWindow = this.cliContextWindow ?? this.contextWindow
    const ratio = this.lastUsage?.context_usage_ratio
    if (typeof ratio === 'number' && ratio > 0 && typeof ratioWindow === 'number' && ratioWindow > 0) {
      // Measured prompt-only: the ratio does NOT include the reply this turn is
      // still producing, so adding `outputTokens` below cannot double-count.
      return this.estimatedUsage(Math.min(ratioWindow, Math.max(1, Math.ceil(ratio * ratioWindow))))
    }
    // No metering available: price the request ourselves. Without this the
    // context meter would read ~0% and auto-compaction would never fire.
    if (this.estimatedInputTokens !== undefined && this.estimatedInputTokens > 0) {
      return this.estimatedUsage(this.estimatedInputTokens)
    }
    return this.estimatedUsage(Math.max(1, Math.ceil(this.turnInputChars / 4)))
  }

  /**
   * One estimated turn reading, shaped exactly like a metered one.
   *
   * The cache buckets are present and zero rather than omitted: this estimate
   * prices the prompt as a single uncached block, and a missing bucket would
   * make the harness withhold the turn's usage disclosure entirely.
   *
   * @param inputTokens - the estimated prompt size, uncached by definition.
   * @returns the harness usage for the turn.
   */
  private estimatedUsage(inputTokens: number): TokenUsage {
    const output = this.outputUsage()
    return {
      inputTokens,
      ...output,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: inputTokens + output.outputTokens,
    }
  }

  /**
   * Record the input-token estimate for the CURRENT request, priced by script
   * mix over the rendered conversation (system + messages) the inner session
   * receives. This is the fallback {@link usage} reaches for only when a turn
   * reported no metering and no context ratio — without it such a turn would
   * read ~0% on the context meter and never trigger auto-compaction.
   * @param system - the host system prompt included in this request.
   * @param messages - the full host message list included in this request.
   */
  recordRequestInput(system: string | undefined, messages: readonly RequestMessage[]): void {
    const rendered = renderInitialFeed(system, messages)
    const imageTokens = feedImageRefs(rendered)
      .reduce((total, ref) => total + estimateImageTokens(ref.width, ref.height), 0)
    this.estimatedInputTokens = Math.max(
      1,
      Math.ceil(estimateTextTokens(feedTextLength(rendered), feedWideCharCount(rendered))) + imageTokens,
    )
  }

  private endTurn(reason: FinishReason, usage?: TokenUsage): void {
    if (this.queue === null) return
    this.turnEndKind = reason.kind
    if (this.textBlock !== undefined) {
      this.emit({ type: 'block-end', index: this.textBlock.index, block: { type: 'text', text: this.textBlock.text } })
    }
    if (this.reasoningBlock !== undefined) {
      this.emit({ type: 'block-end', index: this.reasoningBlock.index, block: { type: 'reasoning', text: this.reasoningBlock.text } })
    }
    this.queue.push({ kind: 'turn-end', reason, usage: usage ?? this.usage() })
    this.queue.close()
  }

  private async consume(q: Query): Promise<void> {
    try {
      const iterator = q[Symbol.asyncIterator]()
      while (true) {
        const next = await iterator.next()
        if (next.done) break
        try {
          this.handle(next.value as SdkMessage)
        } catch (error) {
          this.endTurn({ kind: 'error', failure: { message: `qoder session consumer failed: ${String(error)}`, code: 'BACKEND_ERROR' } })
        }
      }
      this.endTurn({ kind: 'error', failure: { message: 'qoder session stream ended unexpectedly', code: 'STREAM_CLOSED' } })
    } catch (error) {
      this.endTurn({ kind: 'error', failure: { message: `qoder session died: ${String(error)}`, code: 'TRANSPORT' } })
    }
  }

  private handle(message: SdkMessage): void {
    if (message.type === 'stream_event') {
      const event = message.event
      if (event === undefined) return
      // Only a finished request may move the occupancy sample; see
      // {@link requestUsageSample} for which frames carry what.
      const sample = requestUsageSample(message)
      if (sample !== undefined) this.lastUsage = sample
      switch (event.type) {
        case 'content_block_start': {
          const block = event.content_block
          if (block?.type === 'tool_use') {
            // Only host-visible tool calls may be emitted: blocks that arrive
            // while no host stream is active can never be delivered, and their
            // canUseTool/handler sequence is paired by tool-use id anyway, so
            // skipping them keeps the host transcript consistent.
            if (this.queue === null || this.queue.isClosed) break
            const callId = `qoder-${this.callNonce}-${++this.callCounter}`
            if (typeof block.id === 'string' && block.id.length > 0) {
              this.pairing.mapHostCall(callId, block.id)
            }
            const chunkIndex = this.blockIndex++
            const initialArguments = block.input !== undefined && block.input !== null && Object.keys(block.input as object).length > 0
              ? JSON.stringify(block.input)
              : ''
            this.openTool = {
              chunkIndex,
              callId,
              name: hostToolName(block.name ?? ''),
              arguments: initialArguments,
            }
            // Tool-call arguments are generated output, and on an agentic turn
            // they are most of it — measured at 86% of the characters in a
            // three-call turn. The harness prices a tool-call block as
            // `name + arguments` and derives `tok/s` from the output tokens an
            // adapter reports, so leaving them out under-reports speed several
            // fold on exactly the multi-step turns where speed is worth reading.
            // Streaming turns deliver the body through `input_json_delta` and
            // leave `block.input` empty, so this counts only the non-streaming
            // case; the two can never both carry the same bytes.
            this.countOutput(this.openTool.name)
            this.countOutput(initialArguments)
            this.emit({ type: 'block-start', index: chunkIndex, blockType: 'tool-call' })
            this.emit({
              type: 'tool-call-delta',
              index: chunkIndex,
              id: ToolCallId(callId),
              name: this.openTool.name,
              argumentsDelta: '',
            })
          }
          break
        }
        case 'content_block_delta': {
          const delta = event.delta
          if (delta === undefined) return
          if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
            if (this.textBlock === undefined) {
              this.textBlock = { index: this.blockIndex++, text: '' }
              this.emit({ type: 'block-start', index: this.textBlock.index, blockType: 'text' })
            }
            this.textBlock.text += delta.text
            this.countOutput(delta.text)
            this.emit({ type: 'text-delta', index: this.textBlock.index, text: delta.text })
          } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
            if (this.reasoningBlock === undefined) {
              this.reasoningBlock = { index: this.blockIndex++, text: '' }
              this.emit({ type: 'block-start', index: this.reasoningBlock.index, blockType: 'reasoning' })
            }
            this.reasoningBlock.text += delta.thinking
            this.output.addReasoning(delta.thinking)
            this.emit({ type: 'reasoning-delta', index: this.reasoningBlock.index, text: delta.thinking })
          } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string' && this.openTool !== undefined) {
            this.openTool.arguments += delta.partial_json
            this.countOutput(delta.partial_json)
            this.emit({
              type: 'tool-call-delta',
              index: this.openTool.chunkIndex,
              id: ToolCallId(this.openTool.callId),
              argumentsDelta: delta.partial_json,
            })
          }
          break
        }
        case 'content_block_stop': {
          if (this.openTool !== undefined) {
            this.emit({
              type: 'block-end',
              index: this.openTool.chunkIndex,
              block: {
                type: 'tool-call',
                id: ToolCallId(this.openTool.callId),
                name: this.openTool.name,
                arguments: this.openTool.arguments,
              },
            })
            this.toolCalls.push(this.openTool)
            this.openTool = undefined
          }
          break
        }
        case 'message_stop': {
          if (this.toolCalls.length > 0) this.endTurn({ kind: 'tool-calls' })
          break
        }
        default: break
      }
      return
    }
    if (message.type === 'assistant') {
      // No usage is taken from an assembled message: it reports zeros (see
      // {@link requestUsageSample}), and the request frame already supplied the
      // turn's metering.
      // Fallback for turns that streamed no partial events: price whatever the
      // finished message carries, including any tool-call arguments.
      if (this.textBlock === undefined && this.toolCalls.length === 0) {
        // The declared content type only names `text`, but the wire carries the
        // full block shape; tool_use blocks are what a tool-heavy turn spends
        // its output on, so they are read through a local view of that shape.
        const content = (message.message?.content ?? []) as readonly WireContentBlock[]
        for (const block of content) {
          if (block.type !== 'tool_use') continue
          this.countOutput(block.name ?? '')
          this.countOutput(JSON.stringify(block.input ?? ''))
        }
        const text = content
          .filter(block => block.type === 'text')
          .map(block => block.text ?? '')
          .join('')
        if (text.length > 0) {
          this.textBlock = { index: this.blockIndex++, text }
          this.countOutput(text)
          this.emit({ type: 'block-start', index: this.textBlock.index, blockType: 'text' })
          this.emit({ type: 'text-delta', index: this.textBlock.index, text })
        }
      }
      return
    }
    if (message.type === 'result') {
      // The result frame's usage is NOT sampled: it totals the whole inner turn
      // across every provider request, which on a long agentic run is many times
      // the live prompt — see {@link requestUsageSample}. This frame still ends
      // the turn; the occupancy sample stays the last finished request's.
      if (this.abortPending) {
        this.endTurn({ kind: 'aborted', failure: { message: 'qoder turn aborted by host', code: 'ABORTED' } })
        return
      }
      if (this.toolCalls.length > 0) {
        this.endTurn({ kind: 'tool-calls' })
        return
      }
      if (message.subtype === 'success' || message.subtype === undefined) {
        if (this.textBlock === undefined && this.reasoningBlock === undefined) {
          this.endTurn({
            kind: 'error',
            failure: { message: 'qoder model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
          })
        } else {
          this.endTurn({ kind: 'stop' })
        }
        return
      }
      const detail = `${message.subtype} ${safeErrors(message.errors)}`
      if (this.retryWithoutImages(detail)) return
      this.endTurn({
        kind: 'error',
        failure: { message: `qoder turn failed: ${detail}`, code: classifyTurnError(detail) },
      })
    }
  }
}

/**
 * Render tool-result content blocks into the MCP content the inner model
 * reads: text passes through, an image resolves from {@link images} into the
 * MCP image shape or degrades to the harness's own handle text, and anything
 * else is serialized.
 */
export function renderResultContent(blocks: readonly ContentBlock[], images?: ResolvedImages): McpContent[] {
  const content: McpContent[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      content.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      const resolved = images?.get(String(block.attachment.attachmentId))
      if (resolved !== undefined) content.push({ type: 'image', data: resolved.data, mimeType: resolved.mediaType })
      else content.push({ type: 'text', text: textOnlyImageText(block.attachment) })
    } else {
      content.push({ type: 'text', text: JSON.stringify(block) })
    }
  }
  return content
}

/**
 * Vision tokens for one image, estimated with the tile formula the
 * Claude-compatible wire shape this backend follows uses (width x height / 750).
 * The inner CLI reports no usage for the pixels it consumed, so this estimate is
 * the only image occupancy the harness context meter and compaction threshold
 * can see. It is an estimate, not a provider metering figure.
 */
export function estimateImageTokens(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1
  return Math.max(1, Math.ceil((width * height) / 750))
}

/** Literal characters one channel content list contributes to the fallback estimate. */
function contentChars(content: readonly ChannelContent[]): number {
  return content.reduce((total, block) => total + (block.type === 'text' ? block.text.length : 0), 0)
}

/** Safely stringify the SDK error payload for turn diagnostics. */
export function safeErrors(errors: unknown): string {
  if (errors === undefined) return ''
  if (typeof errors === 'string') return errors
  try { return JSON.stringify(errors) } catch { return String(errors) }
}

/**
 * Classify an inner result-frame failure into a harness-routable code. The
 * qoder backend reports context-window and quota rejections as generic
 * per-turn errors, so their message text must be recognized through the shared
 * dsh-llm classifiers; only then does the harness overflow recovery (or quota
 * surfacing) fire instead of a dead-end BACKEND_TURN_ERROR.
 */
export function classifyTurnError(detail: string): string {
  if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  return 'BACKEND_TURN_ERROR'
}

/**
 * Whether a failed turn is the CLI refusing an image it could not decode.
 *
 * qodercli decodes every attached image before the model sees the turn, and
 * reports such a failure with a fixed set of phrasings: the sentence it shows
 * the user, its terminal reason, and the error code underneath. The turn itself
 * is fine — only the pixels are not, which is what makes it safe to resend.
 *
 * @param detail - the failed result frame's subtype and errors.
 */
export function isImageAttachFailure(detail: string): boolean {
  return /image_processing_failed|unable to attach image|invalid or unsupported image data/i.test(detail)
}

/**
 * Warm-session registry with insertion-order LRU eviction, plus the cold
 * one-shot path for side-channel requests (titles, compaction).
 */
export class QoderSessionManager {
  private readonly sessions = new Map<string, QoderSession>()

  /**
   * @param maxSessions - warm-session cap; read per eviction so a settings edit
   *   applies to the next session that overflows the pool.
   * @param runtime - per-session knobs, resolved when each session is created.
   */
  constructor(
    readonly maxSessions: Live<number> = DEFAULT_MAX_SESSIONS,
    private readonly runtime: SessionRuntimeOptions & { coldMaxTurns?: Live<number> } = {},
  ) {}

  /** Existing or fresh warm session for one host session id. */
  forSession(sessionId: string, model: string): QoderSession {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) {
      this.sessions.delete(sessionId)
      this.sessions.set(sessionId, existing)
      return existing
    }
    const session = new QoderSession(sessionId, model, this.runtime)
    this.sessions.set(sessionId, session)
    const cap = readLive(this.maxSessions, DEFAULT_MAX_SESSIONS)
    while (this.sessions.size > cap) {
      const oldest = this.sessions.keys().next()
      if (oldest.done === true) break
      const victim = this.sessions.get(oldest.value)
      this.sessions.delete(oldest.value)
      victim?.close()
    }
    return session
  }

  /** Drop one session (history diverged); the next request rebuilds it cold. */
  dispose(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    this.sessions.delete(sessionId)
    session.close()
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.close()
    this.sessions.clear()
  }

  /** One-shot turn with no warm state: side channels and cold rebuilds. */
  async *coldStream(options: GenerateOptions, prompt: string, model?: string): AsyncGenerator<StreamChunk> {
    const systemPrompt = options.system
    const brand = this.runtime.brand ?? 'cn'
    const conflict = foreignCliOverride(brand)
    if (conflict !== undefined) throw new Error(cliConflictMessage(brand))
    const sdk = await loadSdk(brand)
    const q = sdk.query({
      prompt,
      options: {
        ...qoderCliOptions(brand),
        auth: qodercliAuth(),
        tools: [],
        allowedTools: [],
        canUseTool: gateTools as CanUseTool,
        settingSources: [],
        maxTurns: readLive(this.runtime.coldMaxTurns, DEFAULT_COLD_MAX_TURNS),
        ...systemPrompt === undefined ? {} : { systemPrompt },
        ...model === undefined ? {} : { model },
      },
    })
    const signal = options.signal
    const onAbort = (): void => { void q.interrupt().catch(() => undefined) }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      let text = ''
      let failure: { message: string, code: string } | undefined
      try {
        for await (const message of q) {
          const msg = message as SdkMessage
          if (msg.type === 'assistant') {
            const chunk = (msg.message?.content ?? [])
              .filter(block => block.type === 'text')
              .map(block => block.text ?? '')
              .join('')
            if (chunk.length > 0) text += chunk
          } else if (msg.type === 'result' && msg.subtype !== 'success' && msg.subtype !== undefined) {
            const detail = `${msg.subtype} ${safeErrors(msg.errors)}`
            failure = { message: `qoder side-channel turn failed: ${detail}`, code: classifyTurnError(detail) }
          }
        }
      } catch (error) {
        // Abandoning this loop on a host abort runs the iterator's return(),
        // whose close chain rejects once the child process is already gone;
        // that is the abort, not a transport failure.
        if (signal?.aborted !== true) throw error
      }
      if (signal?.aborted === true) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted by host', code: 'ABORTED' } } }
        return
      }
      // A turn that failed after producing partial text is still a failure:
      // reporting it as a stop would hand the harness a truncated summary and
      // swallow the very overflow the caller needs to recover from.
      if (failure !== undefined) {
        yield { type: 'finish', reason: { kind: 'error', failure } }
        return
      }
      if (text.length === 0) {
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { message: 'qoder side-channel returned no content', code: EMPTY_RESPONSE_CODE } },
        }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      for (let i = 0; i < text.length; i += 192) {
        yield { type: 'text-delta', index: 0, text: text.slice(i, i + 192) }
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield {
        type: 'usage',
        usage: {
          inputTokens: Math.max(1, Math.ceil(prompt.length / 4)),
          outputTokens: Math.max(1, Math.ceil(text.length / 4)),
        },
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      await q.close().catch(() => undefined)
    }
  }
}
