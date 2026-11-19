/**
 * The SDK package behind each brand, and the one daemon it keeps alive.
 *
 * The Qoder editions publish the same API under different scopes, so the rest
 * of the plugin imports this module instead of a package name. The CN SDK is a
 * real dependency; the international one is optional at runtime — a deployment
 * that only has a CN account may not have it installed — so it is imported on
 * demand and its absence is reported to the settings page as a plain error
 * instead of failing the plugin's mount.
 *
 * ## The daemon, and why it has to be reset
 *
 * Every Qoder SDK routes all queries through one **process-wide daemon**,
 * initialized with the first query's launch configuration (CLI path,
 * interpreter, environment, proxy, launch mode) and pinned to it for the life
 * of the process:
 *
 *     DaemonConfigurationConflictError:
 *       Global daemon is already initialized with different options
 *
 * The host is long-lived, so the machine is not: the CLI updates itself,
 * an edition appears, an installer changes the environment, a credential is
 * refreshed. Any of those can leave the ready daemon holding a configuration
 * (or a credential) that no longer applies, and from then on *every* query
 * fails until DSH restarts — which is what the settings page reports as a
 * signed-out account with no models and no quota.
 *
 * Two things keep that from happening:
 *
 * - **The launch configuration is frozen per process** ({@link cliOptions}).
 *   Every call site used to call `qoderCliOptions()` for itself, so two
 *   concurrent reads could describe the machine slightly differently and the
 *   second one was rejected. One frozen object per edition means every query
 *   in this process is identical by construction.
 * - **A conflict is repaired, not reported** ({@link resetDaemon}). The SDK
 *   exports `shutdownDaemon()`, which stops the daemon and clears the slot it
 *   occupies, so the next query initializes a fresh one with the current
 *   configuration. That is what makes sign-in, a CLI update and a credential
 *   refresh take effect without restarting DSH.
 *
 * @module dsh-agent-sdk-bridge/sdk
 */
import type * as QoderSdk from '@qodercn-ai/qodercn-agent-sdk';
import type * as CodeBuddySdk from '@tencent-ai/agent-sdk';
import type { QoderCliOptions } from './cli.ts';
import type { CodeBuddyRegion, QoderBrand } from './brand.ts';
import { codeBuddyEnvironment } from './brand.ts';
/** The subset of the Qoder SDK surface this plugin uses, as one module type. */
export type QoderSdkModule = typeof QoderSdk;
/** The CodeBuddy SDK module, typed from its declarations. */
export type CodeBuddySdkModule = typeof CodeBuddySdk;
/**
 * This edition's launch configuration, computed once per process.
 *
 * Frozen on purpose: the daemon accepts exactly one configuration, so every
 * query has to send the same one. Recomputing it per call let concurrent
 * reads disagree — a machine-wide `QODERCLI_PATH`, a CLI that finished
 * updating between two calls, a PATH entry that appeared — and the daemon
 * rejected whichever arrived second, permanently.
 *
 * {@link resetDaemon} drops the pin, so a real change (install, sign-in, CLI
 * update) is picked up by the next query instead of being frozen out.
 *
 * @param brand - which edition's configuration to return.
 */
export declare function cliOptions(brand: QoderBrand): QoderCliOptions;
/**
 * The signature of this edition's frozen configuration.
 *
 * Kept for diagnostics and tests: two calls in one process always agree, which
 * is the property the daemon requires.
 *
 * @param brand - which edition to describe.
 */
export declare function configurationSignature(brand: QoderBrand): string;
/**
 * Load the SDK for one Qoder edition.
 *
 * One module instance per edition, reused for the process's lifetime: the
 * daemon it owns is reset explicitly rather than by re-importing the package.
 *
 * @param brand - which edition's SDK to load.
 */
export declare function loadSdk(brand: QoderBrand): Promise<QoderSdkModule>;
/**
 * Stop this edition's daemon so the next query starts a clean one.
 *
 * Three situations need this, and they are not distinguishable from the
 * outside — all three look like "the account is gone" until something resets:
 *
 * - the launch configuration changed since the daemon started;
 * - the CLI was updated underneath it;
 * - the credentials on disk changed (sign-in, sign-out, refresh) while the
 *   daemon still holds the ones it loaded at start-up.
 *
 * `shutdownDaemon()` is the SDK's own way to clear the process-wide slot, so
 * the next `query()` initializes against the current machine instead of
 * arguing with a stale daemon until DSH restarts.
 *
 * @param brand - which edition's daemon to replace.
 */
export declare function resetDaemon(brand: QoderBrand): Promise<void>;
/**
 * Fire-and-forget {@link resetDaemon}.
 *
 * For callers that cannot await (a synchronous callback, a consumer loop that
 * has already failed). The daemon is stopped in the background and the next
 * query initializes a fresh one.
 *
 * @param brand - which edition to reset.
 */
export declare function resetSdk(brand: QoderBrand): void;
/** Alias kept for the logout path, whose wording is about discarding state. */
export declare function discardSdk(brand: QoderBrand): void;
/**
 * Whether an error is the SDK's daemon refusing a different configuration.
 *
 * @param error - whatever a query threw.
 */
export declare function isDaemonConflict(error: unknown): boolean;
/**
 * Run one idempotent SDK operation, repairing a stale daemon once.
 *
 * Only use this for operations that can be repeated without side effects
 * (reads), never for a turn that may already have emitted output.
 *
 * @param brand - which edition to query.
 * @param run - the operation, given the module to use.
 */
export declare function withSdk<T>(brand: QoderBrand, run: (sdk: QoderSdkModule) => Promise<T>): Promise<T>;
/**
 * Open one cheap control query so a stale daemon is discovered before a turn
 * starts streaming.
 *
 * A turn cannot be retried once it has emitted output, so the session path has
 * to find out about a configuration conflict first. `getUsageInfo` is a
 * control request: it initializes the daemon and reads the account without
 * running a model turn.
 *
 * @param brand - which edition to probe.
 */
export declare function probeDaemon(brand: QoderBrand): Promise<void>;
/**
 * Load the CodeBuddy Agent SDK.
 *
 * Kept lazy because the package ships its own ~200 MB CLI and is useless to a
 * deployment that never enables CodeBuddy.
 */
export declare function loadCodeBuddySdk(): Promise<CodeBuddySdkModule>;
/** The SDK auth environment for a CodeBuddy login region. */
export { codeBuddyEnvironment };
export type { CodeBuddyRegion };
