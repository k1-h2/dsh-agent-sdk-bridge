/**
 * The two Qoder subscriptions this plugin serves.
 *
 * The CN and international products ship separate SDK packages, separate CLIs,
 * and separate credential directories; their wire protocols are the same shape,
 * so everything downstream of here is parameterised by brand rather than
 * duplicated. The values below are the only place that difference is spelled
 * out: which package to import, where the CLI can live, and which config fields
 * carry the user's choices for that brand.
 *
 * @module dsh-qoder-link/brand
 */

/** A Qoder subscription edition. */
export type QoderBrand = 'cn' | 'global'

/** Everything that differs between the two editions. */
export interface BrandProfile {
  id: QoderBrand
  /** LLM provider route id registered on the harness. */
  provider: string
  /** Display name used when the config leaves it empty. */
  defaultDisplayName: string
  /** Config field that switches this edition on or off. */
  enabledKey: 'cnEnabled' | 'intlEnabled'
  /** SDK package that speaks this edition's protocol. */
  sdkPackage: string
  /** npm packages the CLI can be installed as, most specific first. */
  cliPackages: readonly { scope: string, name: string }[]
  /** Command names an npm global shim exposes for this edition. */
  cliCommands: readonly string[]
  /** Per-user state directory, relative to the home directory. */
  configDirName: string
  /** Setup helper shipped under `scripts/`. */
  setupScript: string
  /** Whether the static catalog is a valid fallback for this edition. */
  staticCatalog: boolean
}

/** The CN edition, which the plugin was originally built for. */
export const CN_BRAND: BrandProfile = {
  id: 'cn',
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
 * unusable entries in the picker. An unreachable intl CLI therefore reports no
 * models, and the page's own guidance points at the install helper.
 */
export const GLOBAL_BRAND: BrandProfile = {
  id: 'global',
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

/** Both brands, in the order the settings page lists them. */
export const BRANDS: readonly BrandProfile[] = [CN_BRAND, GLOBAL_BRAND]

/** Whether a value names one of the two editions. */
export function isQoderBrand(value: unknown): value is QoderBrand {
  return value === 'cn' || value === 'global'
}

/** The profile for one edition. */
export function brandProfile(brand: QoderBrand): BrandProfile {
  return brand === 'global' ? GLOBAL_BRAND : CN_BRAND
}
