/**
 * MiniMax Code over the Agent Client Protocol.
 *
 * `mcode acp` is a stdio ACP server: the plugin starts one process per warm
 * host session, negotiates capabilities, creates one ACP session, and streams
 * `session/update` notifications back to the harness. Host tools are injected
 * as an HTTP MCP server (`mcpServers` in `session/new`), so a tool call the
 * model makes reaches this plugin and then the harness, exactly like the
 * CodeBuddy path.
 *
 * Two MiniMax behaviours shape this module:
 *
 * - ACP has no way to turn off the CLI's built-in tools. The model may call
 *   `bash`/`write`/`read` directly, which would bypass the harness. The client
 *   watches `tool_call` notifications and cancels the prompt before execution;
 *   the turn is then retried with a correction. Host MCP tools are the only
 *   calls allowed through.
 * - The CLI stores one auth state per region and selects it with
 *   `MAVIS_REGION`; every process is pinned so the mainland and international
 *   accounts can coexist.
 *
 * @module dsh-agent-sdk-bridge/minimax
 */
import type { GenerateOptions, RequestMessage, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';
import type { MinimaxRegion } from './brand.ts';
import type { Live } from './live.ts';
/** Default context capacity shown for a MiniMax model that declares none. */
export declare const MINIMAX_DEFAULT_CONTEXT_WINDOW = 512000;
/** Default output cap; the published MiniMax models allow 128k. */
export declare const MINIMAX_DEFAULT_MAX_TOKENS = 128000;
/** How long one model catalog stays fresh. */
export declare const MINIMAX_CACHE_TTL_MS = 300000;
/** Bound for one ACP control round trip. */
export declare const MINIMAX_FETCH_TIMEOUT_MS = 30000;
/** The MCP server name the model sees; its tools are `mcp__dsh-host__*`. */
export declare const MINIMAX_MCP_SERVER = "dsh-host";
/** One model as the settings page and the adapter see it. */
export interface MinimaxModel {
    id: string;
    name: string;
    description?: string;
    contextWindows: number[];
    defaultContextWindow: number;
    vision: boolean;
    reasoning: boolean;
    reasoningEfforts: string[];
    defaultEffort?: string;
}
/** One tool call's result, in the shape the MCP bridge returns. */
export interface MinimaxMcpToolResult {
    content: {
        type: 'text';
        text: string;
    }[];
    isError?: boolean;
}
/**
 * One ACP prompt content block.
 *
 * ACP defines image blocks as base64 `data` plus a `mimeType`; text blocks are
 * the historical shape and remain the only kind a text-only feed produces.
 */
export type MinimaxPromptBlock = {
    type: 'text';
    text: string;
} | {
    type: 'image';
    data: string;
    mimeType: string;
};
/** Login progress and state for one region. */
export interface MinimaxAuthStatus {
    running: boolean;
    region: MinimaxRegion;
    signedIn: boolean;
    startedAt?: number;
    finishedAt?: number;
    /** Authorization URL, once the CLI prints one. */
    url?: string;
    /** Expiry of the stored access token, when reported. */
    expiresAt?: number;
    error?: string;
}
/** One rolling quota window reported by the coding-plan endpoint. */
export interface MinimaxQuotaWindow {
    id: string;
    label: string;
    /** Percent still available; absent when the CLI reports no percentage. */
    remainingPercent?: number;
    /** When this window resets. */
    resetAt?: number;
    /** The plan does not count this window (status 3). */
    unlimited: boolean;
    /** Remaining units, when the endpoint reports a count instead of a ratio. */
    remainingCount?: number;
    totalCount?: number;
}
/** Which quota model the account is on. */
export interface MinimaxPlanInfo {
    kind: 'token-plan' | 'credits' | 'free';
    hasTokenPlan: boolean;
    /** Plan name the account itself reports, when it has one. */
    name?: string;
    tier?: string;
    expiresAt?: number;
    subscriptionType?: string;
}
/** Credit balance from the membership record. */
export interface MinimaxCreditInfo {
    remaining: number;
    purchasedRemaining?: number;
    freeRemaining?: number;
}
/** Display identity of the signed-in MiniMax account. */
export interface MinimaxAccountInfo {
    name?: string;
    email?: string;
    avatar?: string;
    userId?: string;
}
/** What the settings page shows for a MiniMax account. */
export interface MinimaxUsageSnapshot {
    at: number;
    region: MinimaxRegion;
    signedIn: boolean;
    /** Whether the `mcode` executable was found. */
    installed: boolean;
    /** The site refused this machine's network and redirected to the other one. */
    regionBlocked?: boolean;
    error?: string;
    account?: MinimaxAccountInfo;
    plan?: MinimaxPlanInfo;
    credits?: MinimaxCreditInfo;
    /** Coding-plan windows, empty for accounts without a token plan. */
    windows?: MinimaxQuotaWindow[];
}
/** The per-user CLI state directory. */
export declare function minimaxDataDir(): string;
/** Path of one region's auth-state file. */
export declare function minimaxAuthStatePath(region: MinimaxRegion): string;
/** The CLI command name, for error text. */
export declare function minimaxCliCommand(): string;
/** Whether a CLI tool name belongs to this plugin's MCP server. */
export declare function isHostMcpTool(name: string): boolean;
/** The host-side name of an MCP tool, without the namespace. */
export declare function hostMcpToolName(name: string): string;
/** The model config option's values as rows. */
export declare function minimaxModelsFromConfigOptions(options: readonly any[] | null | undefined): MinimaxModel[];
/** Whether the region has a stored login. */
export declare function minimaxSignedIn(region: MinimaxRegion): boolean;
/** How long one quota reading stays fresh. */
export declare const MINIMAX_USAGE_CACHE_TTL_MS = 60000;
/**
 * Whether a URL points at the other site.
 *
 * MiniMax's edge answers a request from the wrong side of the border with a
 * 307 to the other site (`.io` -> `.minimaxi.com` and the reverse). The two
 * are different origins, so a redirect also drops the Authorization header;
 * that is why the CLI reports `401 token is required` instead of an
 * actionable error, and why a stale token is not the real cause.
 */
export declare function minimaxHostBelongsToOtherRegion(region: MinimaxRegion, target: string | URL): boolean;
/** The sentence the card and the chat surface show for a refused region. */
export declare function minimaxRegionBlockMessage(region: MinimaxRegion): string;
/** A region whose hosts refused this machine's network. */
export declare class MinimaxRegionBlockedError extends Error {
    readonly region: MinimaxRegion;
    constructor(region: MinimaxRegion);
}
/** Forget a cached reachability verdict. */
export declare function invalidateMinimaxRegionAccess(region?: MinimaxRegion): void;
/** The last verdict, for synchronous rendering under the card. */
export declare function minimaxRegionBlockedCached(region: MinimaxRegion): boolean;
/**
 * Probe the region's account host for a cross-region redirect.
 *
 * Only a redirect to the other site's domain counts as a block. A timeout or
 * DNS failure leaves the previous verdict alone, so callers report the real
 * network error instead of blaming the IP.
 */
export declare function minimaxRegionBlocked(region: MinimaxRegion, options?: {
    fresh?: boolean;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
}): Promise<boolean>;
/**
 * Build a snapshot from the three account documents.
 *
 * Split out from the network path so the mapping is testable without a live
 * account: the membership record is the source of the plan and credit
 * balance, `remains` only exists for token-plan subscribers.
 */
export declare function minimaxUsageFromParts(parts: {
    region: MinimaxRegion;
    at?: number;
    installed?: boolean;
    userInfo?: Record<string, unknown>;
    workspaces?: readonly Record<string, unknown>[];
    membership?: Record<string, unknown>;
    remains?: Record<string, unknown>;
}): MinimaxUsageSnapshot;
/** Drop a cached quota reading, so the next request re-reads it. */
export declare function invalidateMinimaxUsage(region?: MinimaxRegion): void;
/**
 * Read one region's account, plan and quota.
 *
 * A failed account call keeps the login state and reports the reason in
 * `error`; the settings card shows the account it already knows with that
 * message instead of silently claiming nothing is configured.
 */
export declare function minimaxUsage(region: MinimaxRegion, options?: {
    fresh?: boolean;
    token?: string;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
}): Promise<MinimaxUsageSnapshot>;
/**
 * Browser login/logout, one run per region.
 *
 * The CLI owns the OAuth device flow and the credential file. The plugin only
 * starts the process, surfaces the authorization URL while it waits, and then
 * re-reads the auth-state file to decide whether the region is signed in.
 */
export declare class MinimaxAuth {
    private readonly runs;
    status(region: MinimaxRegion): MinimaxAuthStatus;
    /** Start the CLI's browser login. */
    start(region: MinimaxRegion, onFinish?: (ok: boolean) => void): {
        started: true;
    } | {
        started: false;
        error: string;
    };
    /** Sign one region out; the other region is untouched. */
    logout(region: MinimaxRegion): Promise<MinimaxAuthStatus>;
    /** Cancel any login process (plugin disposal). */
    stop(): void;
}
/** One event the ACP client or the MCP bridge delivers to a turn. */
type SessionEvent = {
    kind: 'text';
    text: string;
} | {
    kind: 'reasoning';
    text: string;
} | {
    kind: 'usage';
    used: number;
    size: number;
} | {
    kind: 'host-tool';
    callId: string;
    name: string;
    args: Record<string, unknown>;
} | {
    kind: 'native-tool';
    name: string;
} | {
    kind: 'prompt-done';
    stopReason: string;
} | {
    kind: 'prompt-error';
    error: Error;
} | {
    kind: 'closed';
    error: Error;
};
/** Options for one ACP process. */
interface MinimaxAcpOptions {
    region: MinimaxRegion;
    cwd: string;
    systemPrompt: string;
    /** HTTP MCP endpoint for host tools; absent for catalog/title calls. */
    mcpUrl?: string;
    mcpToken?: string;
    /** Disable all CLI tools (catalog and title reads need none). */
    disableTools?: boolean;
    timeoutMs?: number;
    onUpdate?: (update: SessionEvent) => void;
    onExit?: (error: Error) => void;
    onPermissionDenied?: (toolName: string) => void;
}
/**
 * One `mcode acp` process and its ACP session.
 *
 * The class only speaks protocol: model/effort config, prompts, cancellation,
 * and the translation of `session/update` into {@link SessionEvent}s. Turn
 * policy (tool calls, retries, harness chunks) lives in {@link MinimaxSession}.
 */
export declare class MinimaxAcp {
    private child;
    private conn;
    private sessionId;
    private configOptions;
    private systemFile;
    private tempDir;
    private closing;
    private stderr;
    private readonly options;
    constructor(options: MinimaxAcpOptions);
    /** The model/effort options the CLI currently offers. */
    get optionsList(): readonly any[];
    /** The selected model config value. */
    get currentModel(): string | undefined;
    /** Start the process and create one ACP session. */
    start(): Promise<void>;
    /**
     * Run one prompt; resolves when the agent's turn ends.
     *
     * ACP carries images as `{ type: 'image', data, mimeType }` blocks next to
     * text, which is what makes a pasted picture reach the model at all; a plain
     * string keeps the historical text-only shape.
     */
    prompt(prompt: string | readonly MinimaxPromptBlock[]): Promise<{
        stopReason: string;
    }>;
    /** Ask the agent to stop the active turn. */
    cancel(): Promise<void>;
    /** Set a session config option and remember the updated list. */
    setConfig(id: string, value: string): Promise<void>;
    /**
     * List the models the CLI actually accepts, with each model's own efforts.
     *
     * The advertised option list can contain values the agent rejects (0.6.12
     * lists a `M3.1-Flash` non-thinking value and answers `Invalid model
     * reasoning` when it is selected). Selecting each value once is the only
     * reliable filter, and it also reveals that non-thinking models drop the
     * `thinkingEffort` option entirely, so reasoning has to be reported per
     * model rather than once for the catalog.
     */
    probeModels(): Promise<MinimaxModel[]>;
    /** Select the model (and, when supported, the thinking effort). */
    selectModel(model: string, effort?: string): Promise<void>;
    /** Exit the session and reap the process. */
    close(): Promise<void>;
}
/** Read the model list for one region (cached). */
export declare class MinimaxCatalog {
    private readonly region;
    private readonly ttlMs;
    private readonly timeoutMs;
    private readonly snapshots;
    private readonly inflight;
    private readonly failures;
    constructor(region: Live<MinimaxRegion>, ttlMs?: Live<number>, timeoutMs?: Live<number>);
    /** Models for one region; a failed refresh keeps the last good list. */
    models(requested?: MinimaxRegion): Promise<readonly MinimaxModel[]>;
    /**
     * The last successful list for a region, without probing.
     *
     * The picker resolves a route on every switch; awaiting an ACP probe there
     * cost a process round-trip whenever the TTL had just expired.
     */
    snapshot(requested?: MinimaxRegion): readonly MinimaxModel[] | undefined;
    /** Why the last refresh failed, or undefined when it succeeded. */
    error(requested?: MinimaxRegion): string | undefined;
    invalidate(region?: MinimaxRegion): void;
    private fetch;
}
/** One shared HTTP MCP server for every warm MiniMax session. */
export declare class MinimaxMcpServer {
    private server;
    private port;
    private readonly bridges;
    /** The base URL, or undefined before {@link start}. */
    get baseUrl(): string | undefined;
    /** Bind to an ephemeral loopback port. */
    start(): Promise<void>;
    /** Add one session's bridge under a random token. */
    register(bridge: MinimaxMcpBridge): {
        url: string;
        token: string;
    };
    unregister(token: string): void;
    /** Close the server and release every session. */
    close(): void;
    private handle;
}
/** One session's view of the MCP server. */
export declare class MinimaxMcpBridge {
    private readonly callHost;
    private schemas;
    constructor(callHost: (name: string, args: Record<string, unknown>) => Promise<MinimaxMcpToolResult>);
    setTools(tools: readonly {
        name: string;
        description: string;
        parameters?: unknown;
    }[]): void;
    tools(): {
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
    }[];
    call(name: string, args: Record<string, unknown>): Promise<MinimaxMcpToolResult>;
}
/** Build a turn's usage from its character counts and the reported context. */
export declare function minimaxTurnUsage(counts: {
    contextUsed?: number;
    inputChars: number;
    outputChars: number;
    reasoningChars: number;
}): TokenUsage;
/**
 * One warm MiniMax conversation for a harness session id.
 *
 * The ACP agent owns the history. A turn ends either when the prompt finishes
 * or when a host tool call is handed to the harness; in the latter case the
 * ACP prompt stays open until the harness returns the result on its next
 * request, exactly like the CodeBuddy bridge.
 */
export declare class MinimaxSession {
    readonly sessionId: string;
    private readonly mcpServer;
    private acp;
    private readonly events;
    private readonly bridge;
    private readonly pending;
    private readonly toolResultTimeoutMs;
    private readonly abortGraceMs;
    private readonly callNonce;
    private toolCounter;
    private promptInFlight;
    private activeTurn;
    private disposed;
    private region;
    private model;
    private effort;
    private systemPrompt;
    private workspace;
    /** The harness workspace; absent means the session owns a temp directory. */
    private requestedCwd;
    private ownsWorkspace;
    private mcpToken;
    private toolSchemas;
    private nativeViolation;
    private cancelSent;
    private correctionCount;
    private observedContextWindow;
    /** Was the last turn closed with tool-calls, leaving the ACP prompt open? */
    private awaitingToolResults;
    /** Host messages already fed to the ACP session, for continuation planning. */
    fedMessages: readonly RequestMessage[] | undefined;
    /** Host system prompt last applied; informational for the adapter. */
    fedSystem: string | undefined;
    constructor(sessionId: string, initialModel: string, mcpServer: MinimaxMcpServer, runtime?: {
        toolResultTimeoutMs?: Live<number>;
        abortGraceMs?: Live<number>;
    });
    /** Model context window observed from a real turn, when one was reported. */
    get contextWindow(): number | undefined;
    /**
     * Whether the ACP session still owns an unfinished turn.
     *
     * A turn closed with `tool-calls` keeps its prompt open while the host runs
     * the tools, so this stays true between the two host requests. A brand-new
     * user message in that state cannot be injected; the adapter rebuilds the
     * session and feeds the whole history instead.
     */
    get busy(): boolean;
    /**
     * Point the session at a region, model and system prompt.
     *
     * @returns true when the warm ACP process was dropped, which means the
     * conversation state must be rebuilt from the durable history.
     */
    configure(region: MinimaxRegion, model: string, options?: {
        effort?: string;
        system?: string;
        cwd?: string;
    }): boolean;
    /** Register the host tools this session's MCP server advertises. */
    ensureTools(tools: readonly {
        name: string;
        description: string;
        parameters?: unknown;
    }[]): void;
    /** Hand the host's tool results to parked handlers. */
    deliverToolResults(tail: readonly {
        role: string;
        toolCallId?: unknown;
        content?: unknown;
        isError?: boolean;
    }[]): void;
    /** Run one harness turn. `feed` is new user content, or null for a continuation. */
    stream(options: GenerateOptions, feed: string | readonly MinimaxPromptBlock[] | null): AsyncGenerator<StreamChunk>;
    /** Tear the ACP process down; parked handlers settle with a cancellation. */
    close(): void;
    private ensureStarted;
    private startPrompt;
    /**
     * Start one ACP prompt and publish its outcome.
     *
     * Cancelling a turn makes the next `session/prompt` fail with "Session
     * already has an active Turn" for a short while even though the cancelled
     * prompt has already resolved. That race is routine here: the native-tool
     * correction is sent immediately after such a cancel, so it is retried with
     * a short backoff instead of being reported as a failed turn.
     */
    private launchPrompt;
    private dropAcp;
    private handleToolCall;
    private finish;
}
/** Warm session pool, keyed by harness session id. */
export declare class MinimaxSessionManager {
    readonly maxSessions: Live<number>;
    private readonly mcpServer;
    private readonly runtime;
    private readonly sessions;
    constructor(maxSessions: Live<number>, mcpServer: MinimaxMcpServer, runtime?: {
        toolResultTimeoutMs?: Live<number>;
        abortGraceMs?: Live<number>;
    });
    forSession(sessionId: string, region: MinimaxRegion, model: string): MinimaxSession;
    dispose(sessionId: string): void;
    closeAll(): void;
}
/** A one-shot turn, used for titles and compaction summaries. */
export declare function minimaxColdStream(region: MinimaxRegion, prompt: string, model: string | undefined, options: GenerateOptions): Promise<StreamChunk[]>;
export {};
