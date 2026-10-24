/**
 * One long-lived inner Qoder CLI session per host session id: a channel-fed
 * `query()` subprocess whose model continuation streams out as harness
 * `StreamChunk`s. Host tool calls travel through an in-process MCP server:
 * the handler parks on a promise, the adapter finishes the turn with
 * `tool-calls`, and the next host request (carrying tool results) resolves
 * the parked promise so the inner model continues with the result in place.
 * @module dsh-llm-qoder/session
 */
import type { ContentBlock, GenerateOptions, RequestMessage, StreamChunk, ToolSchema, TokenUsage } from '@deepseek-ai/dsh-llm';
import type { QoderBrand } from './brand.ts';
import type { Live } from './live.ts';
/** MCP server name this adapter exposes host tools under. */
export declare const MCP_SERVER_NAME = "dsh-host";
/** Warm sessions kept alive when the deployment names no cap. */
export declare const DEFAULT_MAX_SESSIONS = 8;
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
    toolResultTimeoutMs?: Live<number>;
    /** How long the inner process gets to acknowledge an abort. */
    abortGraceMs?: Live<number>;
    /** Which edition's SDK and CLI this session speaks to. */
    brand?: QoderBrand;
}
/** Per-request model policy a warm session runs with. */
export interface SessionModelPolicy {
    reasoningEffort?: string;
    /**
     * The window the route publishes to the harness, and the one the CLI is asked
     * to run with.
     */
    contextWindow?: number;
    /**
     * The window the CLI will *actually* run with, when that differs from the
     * declared one because the model does not advertise it. The CLI measures its
     * context ratio against this, so it is the only honest multiplier for that
     * ratio — see {@link QoderSession.usage}.
     */
    cliContextWindow?: number;
}
/**
 * One user-turn content block on the streaming-input channel. Text is the
 * historical shape; image blocks use the SDK's Claude-compatible base64
 * vision shape (`ImageContentBlock`).
 */
export type ChannelContent = {
    type: 'text';
    text: string;
} | {
    type: 'image';
    source: {
        type: 'base64';
        media_type: string;
        data: string;
    };
};
/** One MCP tool-result content block: text, or the MCP image shape. */
export type McpContent = {
    type: 'text';
    text: string;
} | {
    type: 'image';
    data: string;
    mimeType: string;
};
/** A host tool result delivered to a parked or buffered MCP handler. */
export interface ToolResultPayload {
    content: McpContent[];
    isError: boolean;
}
/**
 * Request-image bytes resolved by the adapter, keyed by attachment id. An id
 * missing from the map degrades to handle text instead of failing the turn.
 */
export type ResolvedImages = ReadonlyMap<string, {
    data: string;
    mediaType: string;
}>;
/**
 * Structural view of the SDK usage this consumer forwards to the harness.
 *
 * Every field is optional because the CLI zeroes the four token counters unless
 * it was started with the switch in `cli.ts`; `credits` and the context ratio
 * survive either way. {@link meteredUsage} decides what is real.
 */
export interface SdkUsage {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    /** The CLI's own measurement of how full this session's context is. */
    context_usage_ratio?: number | null;
}
/** Structural view of the SDK stream events this consumer cares about. */
interface SdkStreamEvent {
    type: string;
    content_block?: {
        type?: string;
        id?: string;
        name?: string;
        input?: unknown;
    };
    delta?: {
        type?: string;
        text?: string;
        thinking?: string;
        partial_json?: string;
    };
    usage?: SdkUsage;
    message?: {
        content?: unknown;
        usage?: SdkUsage;
    };
}
/** The frame fields the request-usage sampler reads. */
export interface UsageFrame {
    type: string;
    event?: SdkStreamEvent;
    usage?: SdkUsage;
}
/**
 * Whether a usage record carries real metering rather than the CLI's zero filler.
 *
 * The CLI attaches a usage record to several frames and leaves the four token
 * counters at zero on all but one kind; a real request always consumed a prompt
 * and produced output, so at least one counter being positive is the whole test.
 */
export declare function carriesTokens(usage: SdkUsage): boolean;
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
export declare function requestUsageSample(message: UsageFrame): SdkUsage | undefined;
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
export declare function meteredUsage(real: SdkUsage | undefined, reasoning: (meteredOutput: number) => {
    reasoningTokens?: number;
}): TokenUsage | undefined;
/**
 * The host tool runtime dispatches by the bare host name; the inner model
 * only ever sees the namespaced MCP form, so strip the prefix on the way out.
 */
export declare function hostToolName(name: string): string;
/** Deny native tools, allow this adapter's MCP tools. */
export declare function gateTools(toolName: string, _input: unknown, options: {
    toolUseID?: string;
}): Promise<unknown>;
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
export declare class ToolResultPairing {
    /** Handlers parked under the tool-use id their host result will arrive as. */
    private readonly parked;
    /** Results that arrived before their handler did, by tool-use id. */
    private readonly buffered;
    /** Tool-use ids `canUseTool` allowed, in execution order, awaiting a handler. */
    private readonly announced;
    /**
     * Announcements a host request has moved past without answering.
     *
     * A handler for one of these can still fire (the CLI decides when to dispatch
     * the MCP call), but no result will ever arrive for it; {@link claim} settles
     * it immediately instead of parking it for the fallback timeout.
     */
    private readonly abandoned;
    /**
     * Host callId (`qoder-N`) → qodercli tool-use id, from the content-block ids.
     *
     * Keyed by a per-session nonce, so a stale entry can never be reached by a
     * later call and is safe to keep across turns; it is dropped with the session.
     */
    private readonly hostCallIds;
    /**
     * Tool-use ids the host was actually shown, and has not answered yet.
     *
     * A host result is filed under a tool-use id only because the adapter emitted
     * that call's block to the host, so these — and only these — are calls the
     * host can still answer. {@link claim} refuses to park on any other id; see
     * the deadlock it prevents there. Mirrors the values of {@link hostCallIds}
     * and is cleared everywhere that map is.
     */
    private readonly hostVisible;
    /** Suffix for a handler that claimed no announcement, so keys stay distinct. */
    private anonymous;
    /** Record the tool-use id `canUseTool` allowed, in execution order. */
    announce(toolUseId: string): void;
    /** Record which tool-use id a model-emitted tool-call block belongs to. */
    mapHostCall(hostCallId: string, toolUseId: string): void;
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
    claim(timeoutMs: number): Promise<ToolResultPayload>;
    /**
     * Park one handler under `key` until the host answers, the request boundary
     * settles it, or — for an unpaired key only — the fallback timeout expires.
     */
    private park;
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
    deliver(hostCallId: string, payload: ToolResultPayload): string;
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
    beginHostRequest(delivered: ReadonlySet<string>, freshUserTurn: boolean): void;
    /**
     * Release every parked handler: the host started a fresh user turn while their
     * calls were still outstanding, so those calls can never be answered.
     */
    cancelParked(): void;
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
    forgetUnclaimed(): void;
    /** Drop all pairing state; the session is being torn down. */
    clear(): void;
    /** How many handlers are waiting for a host result. */
    get parkedCount(): number;
}
/**
 * One warm inner session. All mutation happens on the consumer fiber except
 * the documented turn lifecycle driven by {@link stream}.
 */
export declare class QoderSession {
    readonly sessionId: string;
    private readonly channel;
    /**
     * Lazy: the MCP SDK refuses tool registration after the transport connects,
     * so the inner process only spawns once {@link ensureTools} has registered
     * the host tools (the adapter does that immediately before each stream).
     */
    private q;
    /**
     * Tool-result pairing state. Owned by the session rather than the turn,
     * because a handler can fire after its turn has ended — see
     * {@link ToolResultPairing} for the measurement that proves it.
     */
    private readonly pairing;
    private readonly mcp;
    private readonly registered;
    private queue;
    private model;
    private reasoningEffort;
    private callCounter;
    /**
     * Per-instance suffix for emitted host call ids. Ids must stay unique across
     * the whole host session log: a history divergence rebuilds this class, LRU
     * eviction recreates it, and the harness keys tool-call blocks by id, so a
     * fresh `qoder-1` would collide with the one its predecessor already stored.
     */
    private readonly callNonce;
    private abortPending;
    private disposed;
    /**
     * How the active turn ended, so its cleanup can tell a completed turn (whose
     * unclaimed announcements may still belong to a handler about to fire) from an
     * aborted or failed one (where the CLI cancelled that dispatch).
     */
    private turnEndKind;
    /** Previous request's messages for delta feeding. */
    fedMessages: readonly RequestMessage[] | undefined;
    fedSystem: string | undefined;
    /** This turn's fed characters, reset per turn for per-call token accounting. */
    turnInputChars: number;
    /** Host system prompt captured before spawn for the boot-time systemPrompt. */
    private hostSystem;
    /** Host session workspace; qodercli runs there so its preset reports the session cwd. */
    private sessionCwd;
    private blockIndex;
    private textBlock;
    private reasoningBlock;
    private openTool;
    private toolCalls;
    /**
     * This turn's generated output, priced by script.
     *
     * Counts visible text, reasoning, and tool-call names and arguments — see
     * {@link TurnOutputAccounting} for why the last one matters.
     */
    private readonly output;
    /**
     * Metering of the last provider request that finished in the active turn.
     *
     * Never the `result` frame's usage, which totals the whole inner turn across
     * every request it made — see {@link requestUsageSample}.
     */
    private lastUsage;
    /**
     * The active turn's feed as plain text, when that feed carries image bytes.
     * Kept so a CLI that refuses to decode those bytes can be retried without
     * them instead of failing the turn. Cleared with the turn.
     */
    private feedFallback;
    /**
     * Session-level input token estimate for the CURRENT request, priced by
     * script mix over the rendered conversation the inner session actually
     * receives. It is the last-resort tier of {@link usage}: a turn whose frames
     * carry no metering at all would otherwise read ~0% on the context meter and
     * never trigger auto-compaction, and the CLI's own context ratio is preferred
     * over this whenever the turn reported one.
     */
    private estimatedInputTokens;
    /**
     * The window this route publishes, i.e. the denominator the harness meter
     * divides by. The CLI's context ratio is turned into tokens against this same
     * number, so the meter and the ratio always describe one window.
     */
    private contextWindow;
    /**
     * The window the CLI will actually run with, when that is known to differ
     * from {@link contextWindow} because the model does not advertise the
     * declared one. This is the denominator the CLI itself measures its context
     * ratio against, so it is what the ratio must be multiplied by.
     */
    private cliContextWindow;
    /** Per-session runtime knobs, resolved from the plugin config at creation. */
    private readonly toolResultTimeoutMs;
    private readonly abortGraceMs;
    /** Which edition's CLI (and SDK) this session runs on. */
    private readonly brand;
    constructor(sessionId: string, initialModel: string, runtime?: SessionRuntimeOptions);
    /** Spawn the inner process (first stream only) and attach the consumer. */
    private ensureStarted;
    /** Point the session at a model and its per-request policy. */
    setModel(model: string, policy?: SessionModelPolicy): void;
    /** Record the host system prompt; effective only before the process spawns. */
    setSystem(system: string | undefined): void;
    /**
     * Record the host session workspace; effective only before the process
     * spawns. qodercli inherits the host process cwd otherwise, which would
     * make its preset report the server's launch directory instead of the
     * session's workspace.
     */
    setCwd(cwd: string | undefined): void;
    /**
     * Permission gate for the inner process. Native tools are denied; MCP host
     * tools are allowed, and each allowed call's qodercli tool-use id is recorded
     * so the matching MCP handler can park under the exact id (qodercli asks once
     * per call, in execution order, before dispatching the MCP message).
     */
    private canUseTool;
    /** Register any host tools whose schema this session's MCP server lacks. */
    ensureTools(tools: readonly ToolSchema[]): void;
    /**
     * Deliver host tool results to parked or buffered handlers, keyed by call id,
     * and settle the previous round at this request boundary.
     * @param tail - the host messages appended since the previous request.
     * @param images - adapter-resolved request images keyed by attachment id; an
     *   id missing from the map degrades to handle text.
     */
    deliverToolResults(tail: readonly RequestMessage[], images?: ResolvedImages): void;
    /**
     * Run one inner turn: feed (if any) then pump consumer chunks until finish.
     * @param options - the host request (signal; tools already registered).
     * @param feed - literal text, resolved content blocks (a vision turn), or
     *   null for a pure tool-result continuation.
     * @param fallback - the same feed rendered as text. Used only if the inner
     *   CLI refuses the turn's image bytes, in which case the turn is resent
     *   without them rather than failing (see {@link retryWithoutImages}).
     */
    stream(options: GenerateOptions, feed: string | readonly ChannelContent[] | null, fallback?: string): AsyncGenerator<StreamChunk>;
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
    private retryWithoutImages;
    /** Tear the inner process down; parked calls die with it. */
    close(): void;
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
    private resetTurnState;
    private emit;
    /** Count generated text toward this turn's output tokens. */
    private countOutput;
    /**
     * Price this turn's generated text, by script rather than at a flat rate.
     *
     * {@link TurnOutputAccounting} owns the counters and the harness invariant
     * that `reasoningTokens` is a subset of `outputTokens` — the harness discards
     * a whole reading when it is not.
     */
    private outputUsage;
    private usage;
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
    private estimatedUsage;
    /**
     * Record the input-token estimate for the CURRENT request, priced by script
     * mix over the rendered conversation (system + messages) the inner session
     * receives. This is the fallback {@link usage} reaches for only when a turn
     * reported no metering and no context ratio — without it such a turn would
     * read ~0% on the context meter and never trigger auto-compaction.
     * @param system - the host system prompt included in this request.
     * @param messages - the full host message list included in this request.
     */
    recordRequestInput(system: string | undefined, messages: readonly RequestMessage[]): void;
    private endTurn;
    private consume;
    private handle;
}
/**
 * Render tool-result content blocks into the MCP content the inner model
 * reads: text passes through, an image resolves from {@link images} into the
 * MCP image shape or degrades to the harness's own handle text, and anything
 * else is serialized.
 */
export declare function renderResultContent(blocks: readonly ContentBlock[], images?: ResolvedImages): McpContent[];
/**
 * Vision tokens for one image, estimated with the tile formula the
 * Claude-compatible wire shape this backend follows uses (width x height / 750).
 * The inner CLI reports no usage for the pixels it consumed, so this estimate is
 * the only image occupancy the harness context meter and compaction threshold
 * can see. It is an estimate, not a provider metering figure.
 */
export declare function estimateImageTokens(width: number, height: number): number;
/** Safely stringify the SDK error payload for turn diagnostics. */
export declare function safeErrors(errors: unknown): string;
/**
 * Classify an inner result-frame failure into a harness-routable code. The
 * qoder backend reports context-window and quota rejections as generic
 * per-turn errors, so their message text must be recognized through the shared
 * dsh-llm classifiers; only then does the harness overflow recovery (or quota
 * surfacing) fire instead of a dead-end BACKEND_TURN_ERROR.
 */
export declare function classifyTurnError(detail: string): string;
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
export declare function isImageAttachFailure(detail: string): boolean;
/**
 * Warm-session registry with insertion-order LRU eviction, plus the cold
 * one-shot path for side-channel requests (titles, compaction).
 */
export declare class QoderSessionManager {
    readonly maxSessions: Live<number>;
    private readonly runtime;
    private readonly sessions;
    /**
     * @param maxSessions - warm-session cap; read per eviction so a settings edit
     *   applies to the next session that overflows the pool.
     * @param runtime - per-session knobs, resolved when each session is created.
     */
    constructor(maxSessions?: Live<number>, runtime?: SessionRuntimeOptions & {
        coldMaxTurns?: Live<number>;
    });
    /** Existing or fresh warm session for one host session id. */
    forSession(sessionId: string, model: string): QoderSession;
    /** Drop one session (history diverged); the next request rebuilds it cold. */
    dispose(sessionId: string): void;
    closeAll(): void;
    /** One-shot turn with no warm state: side channels and cold rebuilds. */
    coldStream(options: GenerateOptions, prompt: string, model?: string): AsyncGenerator<StreamChunk>;
}
export {};
