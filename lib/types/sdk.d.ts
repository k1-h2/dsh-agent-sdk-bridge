/**
 * The SDK package behind each brand.
 *
 * The Qoder editions publish the same API under different scopes, so the rest
 * of the plugin imports this module instead of a package name. The CN SDK is a
 * real dependency and is loaded eagerly; the international one is optional at
 * runtime — a deployment that only has a CN account may not have it installed —
 * so it is imported on demand and its absence is reported to the settings page
 * as a plain error instead of failing the plugin's mount.
 *
 * CodeBuddy has its own, unrelated API and is loaded dynamically for the same
 * reason: an account may never use it, and its package carries a large CLI.
 *
 * ## Why modules are reloaded
 *
 * Every Qoder SDK routes all queries through one **process-wide daemon** that
 * is initialized with the first query's launch configuration (CLI path,
 * interpreter, environment, proxy) and then refuses any different one for the
 * life of the process:
 *
 *     DaemonConfigurationConflictError:
 *       Global daemon is already initialized with different options
 *
 * The host is long-lived, so its configuration is not: a CLI can be
 * reinstalled, an edition can appear, an installer can change the machine
 * environment. When that happens the ready daemon no longer matches and every
 * later query fails until the process restarts — a state the settings page
 * cannot recover from on its own.
 *
 * So the module tracks the configuration signature it loaded under and takes a
 * fresh instance whenever the signature changes; {@link resetSdk} does the same
 * after a conflict is observed. A new instance has an empty daemon registry, so
 * it initializes against the current configuration instead of arguing with the
 * old one.
 *
 * @module dsh-agent-sdk-bridge/sdk
 */
import type * as QoderSdk from '@qodercn-ai/qodercn-agent-sdk';
import type * as CodeBuddySdk from '@tencent-ai/agent-sdk';
import type { CodeBuddyRegion, QoderBrand } from './brand.ts';
import { codeBuddyEnvironment } from './brand.ts';
/** The subset of the Qoder SDK surface this plugin uses, as one module type. */
export type QoderSdkModule = typeof QoderSdk;
/** The CodeBuddy SDK module, typed from its declarations. */
export type CodeBuddySdkModule = typeof CodeBuddySdk;
/**
 * The launch configuration a Qoder query would use, as a comparable string.
 *
 * Mirrors the fields the SDK's own daemon compares before reusing itself. The
 * environment is included because the SDK hands it to the CLI verbatim, and a
 * difference there is enough to make the daemon reject a query.
 *
 * @param brand - which edition's configuration to describe.
 * @returns a stable string that changes exactly when the configuration does.
 */
export declare function configurationSignature(brand: QoderBrand): string;
/**
 * Load the SDK for one Qoder edition, under its current configuration.
 *
 * @param brand - which edition's SDK to load.
 * @returns the SDK module.
 */
export declare function loadSdk(brand: QoderBrand): Promise<QoderSdkModule>;
/**
 * Drop the loaded instance so the next {@link loadSdk} starts a new daemon.
 *
 * @param brand - which edition to reset.
 */
export declare function resetSdk(brand: QoderBrand): void;
/**
 * Whether an error is the SDK's daemon refusing a different configuration.
 *
 * @param error - whatever a query threw.
 */
export declare function isDaemonConflict(error: unknown): boolean;
/**
 * Run one idempotent SDK operation, recovering from a daemon conflict once.
 *
 * A conflict means the daemon was initialized under a configuration that no
 * longer applies. A fresh module instance starts an empty daemon with the
 * current one, so the retry succeeds without a restart. Only use this for
 * operations that can be repeated without side effects (reads), never for a
 * turn that may already have emitted output.
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
