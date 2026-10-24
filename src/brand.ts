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
export type QoderBrand = 'cn' | 'global'
/** The CodeBuddy integration. Its login region is a config choice, not a brand. */
export type CodeBuddyBrandId = 'codebuddy'
/** Every provider route this plugin registers. */
export type BrandId = QoderBrand | CodeBuddyBrandId

/** Which SDK family a brand belongs to. */
export type BrandFamily = 'qoder' | 'codebuddy'

/** CodeBuddy's two public login regions. Enterprise domains are out of scope. */
export type CodeBuddyRegion = 'global' | 'cn'

/** Everything that differs between provider brands. */
export interface BrandProfile {
  id: BrandId
  family: BrandFamily
  /** LLM provider route id registered on the harness. */
  provider: string
  /** Display name used when the config leaves it empty. */
  defaultDisplayName: string
  /** Config field that switches this brand on or off. */
  enabledKey: 'cnEnabled' | 'intlEnabled' | 'codebuddyEnabled'
  /** SDK package that speaks this brand's protocol. */
  sdkPackage: string
  /** npm packages the CLI can be installed as, most specific first. */
  cliPackages: readonly { scope: string, name: string }[]
  /** Command names an npm global shim exposes. */
  cliCommands: readonly string[]
  /** Per-user state directory, relative to the home directory. */
  configDirName: string
  /** Setup helper shipped under `scripts/`, or null when login is in-process. */
  setupScript: string | null
  /** Whether the static Qoder catalog is a valid fallback. */
  staticCatalog: boolean
}

/** The CN edition, which the plugin was originally built for. */
export const CN_BRAND: BrandProfile = {
  id: 'cn',
  family: 'qoder',
  provider: 'qoder-cn',
  defaultDisplayName: 'Qoder CN',
  enabledKey: 'cnEnabled',
  sdkPackage: '@qodercn-ai/qodercn-agent-sdk',
  cliPackages: [{ scope: '@qodercn-ai', name: 'qoderclicn' }],
  cliCommands: ['qoderclicn', 'qodercn'],
  configDirName: '.qoder-cn',
  setupScript: 'setup-qoderclicn.bat',
  staticCatalog: true,
}

/**
 * The international edition.
 *
 * The static CN catalog is deliberately NOT reused: model ids differ between
 * the two plans, and a fallback the account cannot actually run would put
 * unusable entries in the picker.
 */
export const GLOBAL_BRAND: BrandProfile = {
  id: 'global',
  family: 'qoder',
  provider: 'qoder-intl',
  defaultDisplayName: 'Qoder 国际版',
  enabledKey: 'intlEnabled',
  sdkPackage: '@qoder-ai/qoder-agent-sdk',
  cliPackages: [{ scope: '@qoder-ai', name: 'qodercli' }],
  cliCommands: ['qodercli', 'qoder'],
  configDirName: '.qoder',
  setupScript: 'setup-qodercli.bat',
  staticCatalog: false,
}

/**
 * CodeBuddy, served through Tencent's Agent SDK.
 *
 * The SDK bundles its own CLI (`@tencent-ai/codebuddy-code`), so there is no
 * global install step and no setup script: login is an SDK call whose region
 * is chosen per request (`external` for the international site, `internal`
 * for the mainland one). Enterprise/IOA/self-hosted login is out of scope.
 */
export const CODEBUDDY_BRAND: BrandProfile = {
  id: 'codebuddy',
  family: 'codebuddy',
  provider: 'codebuddy',
  defaultDisplayName: 'CodeBuddy',
  enabledKey: 'codebuddyEnabled',
  sdkPackage: '@tencent-ai/agent-sdk',
  cliPackages: [{ scope: '@tencent-ai', name: 'codebuddy-code' }],
  cliCommands: ['codebuddy', 'cbc'],
  configDirName: '.codebuddy',
  setupScript: null,
  staticCatalog: false,
}

/** Every brand, in the order the settings pages list them. */
export const BRANDS: readonly BrandProfile[] = [CN_BRAND, GLOBAL_BRAND, CODEBUDDY_BRAND]

/** Whether a value names a Qoder edition. */
export function isQoderBrand(value: unknown): value is QoderBrand {
  return value === 'cn' || value === 'global'
}

/** Whether a value names one of the provider brands. */
export function isBrandId(value: unknown): value is BrandId {
  return isQoderBrand(value) || value === 'codebuddy'
}

/** Whether a value names a CodeBuddy login region. */
export function isCodeBuddyRegion(value: unknown): value is CodeBuddyRegion {
  return value === 'global' || value === 'cn'
}

/** The profile for one brand. */
export function brandProfile(brand: BrandId): BrandProfile {
  if (brand === 'codebuddy') return CODEBUDDY_BRAND
  return brand === 'global' ? GLOBAL_BRAND : CN_BRAND
}

/** The SDK environment a CodeBuddy region logs into. */
export function codeBuddyEnvironment(region: CodeBuddyRegion): 'external' | 'internal' {
  return region === 'cn' ? 'internal' : 'external'
}
