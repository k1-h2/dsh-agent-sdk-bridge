/**
 * The SDK package behind each brand.
 *
 * Both editions publish the same API under different scopes, so the rest of the
 * plugin imports this module instead of a package name. The CN SDK is a real
 * dependency and is loaded statically; the international one is optional at
 * runtime — a deployment that only has a CN account may not have it installed —
 * so it is imported on demand and its absence is reported to the settings page
 * as a plain error instead of failing the plugin's mount.
 *
 * The module is typed against the CN package because the two are API-compatible:
 * every call site here is shared, and the only thing that changes is which
 * process the protocol is spoken to.
 *
 * @module dsh-qoder-link/sdk
 */
import type * as QoderSdk from '@qodercn-ai/qodercn-agent-sdk';
import type { QoderBrand } from './brand.ts';
/** The subset of the SDK surface this plugin uses, as one module type. */
export type QoderSdkModule = typeof QoderSdk;
/**
 * Load the SDK for one brand.
 *
 * The CN module has no failure mode beyond a broken installation, which makes
 * the plugin itself unloadable and is therefore not caught here. The
 * international module can legitimately be absent, so its rejection carries an
 * actionable message for the settings page.
 *
 * @param brand - which edition's SDK to load.
 * @returns the SDK module.
 */
export declare function loadSdk(brand: QoderBrand): Promise<QoderSdkModule>;
