/**
 * Account quota and usage, read through the CLI's own control protocol.
 *
 * The SDK exposes `getUsageInfo()`, which asks the CLI to query the account's
 * quota endpoint with the credentials the CLI already holds — the same numbers
 * the Qoder desktop and VS Code clients show on their account panel. Doing it
 * this way (rather than calling the endpoint ourselves) keeps token refresh,
 * endpoint election and encryption inside the CLI, which owns them.
 *
 * One short-lived query is enough: no model turn runs, and the answer is cached
 * for a minute so opening the settings page repeatedly does not spawn a CLI on
 * every render. Failures are returned, not thrown: a page that cannot read the
 * quota must still render the rest of its settings.
 *
 * @module dsh-qoder-link/usage
 */
import type { AccountInfo, UsageInfo } from '@qodercn-ai/qodercn-agent-sdk';
import type { Live } from './live.ts';
import type { QoderBrand } from './brand.ts';
/** How long one quota reading stays fresh by default. */
export declare const DEFAULT_USAGE_CACHE_TTL_MS = 60000;
/** Upper bound on one quota round trip. */
export declare const DEFAULT_USAGE_TIMEOUT_MS = 20000;
/** One quota reading, successful or not. */
export interface UsageSnapshot {
    /** When the reading was taken. */
    at: number;
    /** Account quota; absent when the CLI could not answer. */
    usage?: UsageInfo;
    /** Signed-in account identity, when the CLI reports it. */
    account?: AccountInfo;
    /** Why the quota is missing, in the CLI's own words. */
    error?: string;
}
/** Cached quota reader for one brand. */
export declare class QoderUsage {
    private readonly brand;
    private readonly ttlMs;
    private readonly timeoutMs;
    private cached;
    private inflight;
    /**
     * @param brand - which edition's CLI answers.
     * @param ttlMs - how long a reading stays fresh; read per use.
     * @param timeoutMs - how long one round trip may take.
     */
    constructor(brand: QoderBrand, ttlMs?: Live<number>, timeoutMs?: Live<number>);
    /**
     * Read the quota, or serve the cached reading while it is still fresh.
     *
     * @param fresh - ignore the cache; the page's refresh button.
     * @returns the reading; `error` carries a failed lookup instead of throwing.
     */
    read(fresh?: boolean): Promise<UsageSnapshot>;
    /** Drop the cached reading. */
    invalidate(): void;
    private fetch;
}
