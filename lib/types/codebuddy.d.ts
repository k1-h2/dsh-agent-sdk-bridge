/**
 * CodeBuddy's account, catalog, login and warm sessions.
 *
 * The SDK is the CodeBuddy Code SDK (`@tencent-ai/agent-sdk`). It bundles its
 * own CLI, so unlike the Qoder brands there is no global install and no batch
 * helper: login is an SDK call whose region is `external` (international) or
 * `internal` (mainland). Enterprise/IOA/self-hosted login is out of scope.
 *
 * One CodeBuddy provider serves both regions; the region is a setting, so the
 * models and account shown always belong to the selected login.
 *
 * @module dsh-agent-sdk-bridge/codebuddy
 */
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { RawLanguageModel } from '@tencent-ai/agent-sdk';
import type { CodeBuddyRegion } from './brand.ts';
import type { Live } from './live.ts';
/** Default context capacity assumed for a CodeBuddy model that declares none. */
export declare const CODEBUDDY_DEFAULT_CONTEXT_WINDOW = 200000;
/** Default output cap when the catalog declares none. */
export declare const CODEBUDDY_DEFAULT_MAX_TOKENS = 32000;
/** How long one CodeBuddy account/catalog read stays fresh. */
export declare const CODEBUDDY_CACHE_TTL_MS = 300000;
/** Give up on one CodeBuddy control round trip after this long. */
export declare const CODEBUDDY_FETCH_TIMEOUT_MS = 30000;
/** One model as the settings page and the adapter see it. */
export interface CodeBuddyModel {
    id: string;
    name: string;
    description?: string;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    contextWindows: number[];
    defaultContextWindow: number;
    vision: boolean;
    reasoningEfforts?: string[];
    defaultEffort?: string;
    /** Credit multiplier, parsed from the catalog's `x0.79 credits` string. */
    priceFactor?: number;
}
/** One signed-in CodeBuddy account. */
export interface CodeBuddyAccount {
    email?: string;
    organization?: string;
    subscriptionType?: string;
}
/** The account reading served to the settings page. */
export interface CodeBuddyUsageSnapshot {
    at: number;
    account?: CodeBuddyAccount;
    error?: string;
}
/** Login progress for one region. */
export interface CodeBuddyAuthStatus {
    running: boolean;
    region: CodeBuddyRegion;
    startedAt?: number;
    finishedAt?: number;
    /** Browser URL, once the CLI hands one over. */
    url?: string;
    user?: {
        userId: string;
        userName: string;
        userNickname: string;
    };
    error?: string;
}
/** Turn one raw catalog entry into the model row this plugin uses. */
export declare function toCodeBuddyModel(model: RawLanguageModel): CodeBuddyModel;
/**
 * The account's model catalog for one region.
 *
 * CodeBuddy only answers this after the CLI has started, so the read costs one
 * process boot. Results are cached per region and fall back to the last good
 * list when a refresh fails.
 */
export declare class CodeBuddyCatalog {
    private readonly region;
    private readonly ttlMs;
    private readonly timeoutMs;
    private readonly snapshots;
    private readonly inflight;
    private readonly failures;
    constructor(region: Live<CodeBuddyRegion>, ttlMs?: Live<number>, timeoutMs?: Live<number>);
    /** Models for the current region; a failed refresh keeps the last good list. */
    models(): Promise<readonly CodeBuddyModel[]>;
    /** Why the last refresh failed, or undefined when it succeeded. */
    error(): string | undefined;
    invalidate(region?: CodeBuddyRegion): void;
    private fetch;
}
/** Read the signed-in account once per TTL. */
export declare class CodeBuddyAccountReader {
    private readonly region;
    private readonly ttlMs;
    private readonly timeoutMs;
    private cached;
    private inflight;
    constructor(region: Live<CodeBuddyRegion>, ttlMs?: Live<number>, timeoutMs?: Live<number>);
    read(fresh?: boolean): Promise<CodeBuddyUsageSnapshot>;
    invalidate(): void;
    private fetch;
}
/** Turn a raw SDK failure into a sentence the settings page can act on. */
export declare function authErrorText(region: CodeBuddyRegion, error: unknown): string;
/**
 * Browser login/logout per region.
 *
 * The SDK owns the browser flow: it emits a URL, waits for the CLI to report
 * the result, and stores the credential where the CLI reads it. This manager
 * only remembers progress so the settings page can poll it.
 */
export declare class CodeBuddyAuth {
    private readonly runs;
    /** Start a login; refuses while the same region is already logging in. */
    start(region: CodeBuddyRegion, onFinish?: (ok: boolean) => void): {
        started: true;
    } | {
        started: false;
        error: string;
    };
    status(region: CodeBuddyRegion): CodeBuddyAuthStatus;
    /** Clear the cached credential for one region. */
    logout(region: CodeBuddyRegion): Promise<{
        ok: true;
    } | {
        ok: false;
        error: string;
    }>;
    private login;
}
/**
 * One warm CodeBuddy session for a host session id.
 *
 * Mirrors the Qoder session's shape: the host's tool calls are exposed through
 * an in-process MCP server; each handler parks until the host delivers that
 * round's results on its next request. The inner CLI keeps the conversation,
 * so a continuation carries only new user text.
 */
export declare class CodeBuddySession {
    readonly sessionId: string;
    private session;
    private mcp;
    private readonly pairing;
    private readonly registered;
    private queue;
    private disposed;
    private abortPending;
    private turnEndKind;
    private blockIndex;
    private textBlock;
    private reasoningBlock;
    private tools;
    private openTool;
    private callCounter;
    private readonly callNonce;
    private lastUsage;
    private resultUsage;
    private readonly output;
    private inputChars;
    private readonly toolResultTimeoutMs;
    private readonly abortGraceMs;
    private region;
    private model;
    private effort;
    private systemPrompt;
    private cwd;
    /** Host messages already fed to the inner session, for continuation planning. */
    fedMessages: readonly import('@deepseek-ai/dsh-llm').RequestMessage[] | undefined;
    /** Host system prompt last applied; informational for the adapter. */
    fedSystem: string | undefined;
    constructor(sessionId: string, initialModel: string, runtime?: {
        toolResultTimeoutMs?: Live<number>;
        abortGraceMs?: Live<number>;
    });
    /** Point the session at a region, model and optional system prompt. */
    configure(region: CodeBuddyRegion, model: string, options?: {
        effort?: string;
        system?: string;
        cwd?: string;
    }): void;
    /** Register any host tools whose schema this session's MCP server lacks. */
    ensureTools(tools: readonly {
        name: string;
        description: string;
        parameters?: unknown;
    }[]): void;
    /** Hand the host's tool results to parked or buffered handlers. */
    deliverToolResults(tail: readonly {
        role: string;
        toolCallId?: unknown;
        content?: unknown;
        isError?: boolean;
    }[]): void;
    /** Run one host turn; `feed` is new user text, or null for a tool continuation. */
    stream(options: GenerateOptions, feed: string | null): AsyncGenerator<StreamChunk>;
    /** Tear the inner CLI down; parked handlers settle with a cancellation. */
    close(): void;
    private ensureStarted;
    private canUseTool;
    private consume;
    private handle;
    private resetTurnState;
    private emit;
    private countOutput;
    private usage;
    private endTurn;
}
/**
 * Warm sessions keyed by host session id. A region change retires the old
 * session rather than mutating one, because the CLI process was started with
 * the previous region's endpoint.
 */
export declare class CodeBuddySessionManager {
    readonly maxSessions: Live<number>;
    private readonly runtime;
    private readonly sessions;
    constructor(maxSessions: Live<number>, runtime?: {
        toolResultTimeoutMs?: Live<number>;
        abortGraceMs?: Live<number>;
    });
    forSession(sessionId: string, region: CodeBuddyRegion, model: string): CodeBuddySession;
    dispose(sessionId: string): void;
    closeAll(): void;
}
/** A one-shot turn, used for titles and compaction summaries. */
export declare function codeBuddyColdStream(region: CodeBuddyRegion, prompt: string, model: string | undefined, options: GenerateOptions): Promise<StreamChunk[]>;
