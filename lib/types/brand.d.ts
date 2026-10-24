/**
 * The agent SDKs this plugin serves.
 *
 * Each provider family ships its own SDK, CLI and credential store; their
 * wire protocols are similar enough that the rest of the plugin is keyed by
 * brand rather than duplicated. This module is the only place those
 * differences are spelled out: which package to import, where the CLI lives,
 * and which config fields carry the user's choices.
 *
 * @module dsh-agent-sdk-bridge/brand
 */
/** The Qoder editions, whose provider ids predate this bridge. */
export type QoderBrand = 'cn' | 'global';
/** The CodeBuddy integration. Its login region is a config choice, not a brand. */
export type CodeBuddyBrandId = 'codebuddy';
/** Every provider route this plugin registers. */
export type BrandId = QoderBrand | CodeBuddyBrandId;
/** Which SDK family a brand belongs to. */
export type BrandFamily = 'qoder' | 'codebuddy';
/** CodeBuddy's two public login regions. Enterprise domains are out of scope. */
export type CodeBuddyRegion = 'global' | 'cn';
/** Everything that differs between provider brands. */
export interface BrandProfile {
    id: BrandId;
    family: BrandFamily;
    /** LLM provider route id registered on the harness. */
    provider: string;
    /** Display name used when the config leaves it empty. */
    defaultDisplayName: string;
    /** Config field that switches this brand on or off. */
    enabledKey: 'cnEnabled' | 'intlEnabled' | 'codebuddyEnabled';
    /** SDK package that speaks this brand's protocol. */
    sdkPackage: string;
    /** npm packages the CLI can be installed as, most specific first. */
    cliPackages: readonly {
        scope: string;
        name: string;
    }[];
    /** Command names an npm global shim exposes. */
    cliCommands: readonly string[];
    /** Per-user state directory, relative to the home directory. */
    configDirName: string;
    /** Setup helper shipped under `scripts/`, or null when login is in-process. */
    setupScript: string | null;
    /** Whether the static Qoder catalog is a valid fallback. */
    staticCatalog: boolean;
}
/** The CN edition, which the plugin was originally built for. */
export declare const CN_BRAND: BrandProfile;
/**
 * The international edition.
 *
 * The static CN catalog is deliberately NOT reused: model ids differ between
 * the two plans, and a fallback the account cannot actually run would put
 * unusable entries in the picker.
 */
export declare const GLOBAL_BRAND: BrandProfile;
/**
 * CodeBuddy, served through Tencent's Agent SDK.
 *
 * The SDK bundles its own CLI (`@tencent-ai/codebuddy-code`), so there is no
 * global install step and no setup script: login is an SDK call whose region
 * is chosen per request (`external` for the international site, `internal`
 * for the mainland one). Enterprise/IOA/self-hosted login is out of scope.
 */
export declare const CODEBUDDY_BRAND: BrandProfile;
/** Every brand, in the order the settings pages list them. */
export declare const BRANDS: readonly BrandProfile[];
/** Whether a value names a Qoder edition. */
export declare function isQoderBrand(value: unknown): value is QoderBrand;
/** Whether a value names one of the provider brands. */
export declare function isBrandId(value: unknown): value is BrandId;
/** Whether a value names a CodeBuddy login region. */
export declare function isCodeBuddyRegion(value: unknown): value is CodeBuddyRegion;
/** The profile for one brand. */
export declare function brandProfile(brand: BrandId): BrandProfile;
/** The SDK environment a CodeBuddy region logs into. */
export declare function codeBuddyEnvironment(region: CodeBuddyRegion): 'external' | 'internal';
