/**
 * The SDK package behind each brand.
 *
 * The Qoder editions publish the same API under different scopes, so the rest
 * of the plugin imports this module instead of a package name. The CN SDK is a
 * real dependency and is loaded statically; the international one is optional
 * at runtime — a deployment that only has a CN account may not have it
 * installed — so it is imported on demand and its absence is reported to the
 * settings page as a plain error instead of failing the plugin's mount.
 *
 * CodeBuddy has its own, unrelated API and is loaded dynamically for the same
 * reason: an account may never use it, and its package carries a large CLI.
 *
 * The Qoder module is typed against the CN package because the two are
 * API-compatible: every Qoder call site is shared, and the only thing that
 * changes is which process the protocol is spoken to.
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
 * Load the SDK for one Qoder edition.
 *
 * @param brand - which edition's SDK to load.
 * @returns the SDK module.
 */
export declare function loadSdk(brand: QoderBrand): Promise<QoderSdkModule>;
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
