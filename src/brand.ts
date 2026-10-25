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
/** The MiniMax Code integration, spoken over ACP. */
export type MinimaxBrandId = 'minimax'
/** Every provider route this plugin registers. */
export type BrandId = QoderBrand | CodeBuddyBrandId | MinimaxBrandId

/** Which SDK family a brand belongs to. */
export type BrandFamily = 'qoder' | 'codebuddy' | 'minimax'

/** CodeBuddy's two public login regions. Enterprise domains are out of scope. */
export type CodeBuddyRegion = 'global' | 'cn'

/** MiniMax Code's two public login regions. */
export type MinimaxRegion = 'global' | 'cn'

/** Everything that differs between provider brands. */
export interface BrandProfile {
  id: BrandId
  family: BrandFamily
  /** LLM provider route id registered on the harness. */
  provider: string
  /** Display name used when the config leaves it empty. */
  defaultDisplayName: string
  /** Config field that switches this brand on or off. */
  enabledKey: 'cnEnabled' | 'intlEnabled' | 'codebuddyEnabled' | 'minimaxEnabled'
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

/**
 * MiniMax Code, spoken over the Agent Client Protocol.
 *
 * `mcode acp` runs as a stdio ACP server. Unlike CodeBuddy, there is no SDK
 * package to import: the plugin speaks the protocol directly and the CLI owns
 * login, model selection and the upstream account. The login region is a
 * config choice (`MAVIS_REGION` pins each process), not a brand.
 */
export const MINIMAX_BRAND: BrandProfile = {
  id: 'minimax',
  family: 'minimax',
  provider: 'minimax-acp',
  defaultDisplayName: 'MiniMax Code',
  enabledKey: 'minimaxEnabled',
  sdkPackage: '@agentclientprotocol/sdk',
  cliPackages: [{ scope: '@minimax-ai', name: 'code' }],
  cliCommands: ['mcode'],
  configDirName: '.minimax',
  setupScript: null,
  staticCatalog: false,
}

/** Every brand, in the order the settings pages list them. */
export const BRANDS: readonly BrandProfile[] = [CN_BRAND, GLOBAL_BRAND, CODEBUDDY_BRAND, MINIMAX_BRAND]

/** Whether a value names a Qoder edition. */
export function isQoderBrand(value: unknown): value is QoderBrand {
  return value === 'cn' || value === 'global'
}

/** Whether a value names one of the provider brands. */
export function isBrandId(value: unknown): value is BrandId {
  return isQoderBrand(value) || value === 'codebuddy' || value === 'minimax'
}

/** Whether a value names a CodeBuddy login region. */
export function isCodeBuddyRegion(value: unknown): value is CodeBuddyRegion {
  return value === 'global' || value === 'cn'
}

/** Whether a value names a MiniMax Code login region. */
export function isMinimaxRegion(value: unknown): value is MinimaxRegion {
  return value === 'global' || value === 'cn'
}

/** The profile for one brand. */
export function brandProfile(brand: BrandId): BrandProfile {
  if (brand === 'codebuddy') return CODEBUDDY_BRAND
  if (brand === 'minimax') return MINIMAX_BRAND
  return brand === 'global' ? GLOBAL_BRAND : CN_BRAND
}

/**
 * The region name the MiniMax CLI uses internally.
 *
 * The CLI calls the mainland site `cn` and the international one `en`; its
 * login command accepts `global` and maps it to `en`. Processes are pinned
 * with `MAVIS_REGION`, which also expects `cn`/`en`.
 */
export function minimaxCliRegion(region: MinimaxRegion): 'cn' | 'en' {
  return region === 'cn' ? 'cn' : 'en'
}

/** The SDK environment a CodeBuddy region logs into. */
export function codeBuddyEnvironment(region: CodeBuddyRegion): 'external' | 'internal' {
  return region === 'cn' ? 'internal' : 'external'
}
