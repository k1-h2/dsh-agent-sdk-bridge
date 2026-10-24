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

import * as cnSdk from '@qodercn-ai/qodercn-agent-sdk'
import type * as QoderSdk from '@qodercn-ai/qodercn-agent-sdk'
import type { QoderBrand } from './brand.ts'
import { brandProfile } from './brand.ts'

/** The subset of the SDK surface this plugin uses, as one module type. */
export type QoderSdkModule = typeof QoderSdk

let globalSdk: Promise<QoderSdkModule> | undefined

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
export function loadSdk(brand: QoderBrand): Promise<QoderSdkModule> {
  if (brand === 'cn') return Promise.resolve(cnSdk as QoderSdkModule)
  globalSdk ??= importGlobalSdk()
  return globalSdk
}

/**
 * Import the international SDK by a variable specifier.
 *
 * A literal specifier would make TypeScript and the bundler require the package
 * at build time, which is exactly what an optional edition must not do. The
 * specifier is a constant, so no user input can influence it.
 */
async function importGlobalSdk(): Promise<QoderSdkModule> {
  const specifier = brandProfile('global').sdkPackage
  try {
    return await import(/* @vite-ignore */ specifier) as QoderSdkModule
  } catch (error) {
    // Let a later read retry: the package may be installed while DSH is running.
    globalSdk = undefined
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`未安装国际版 SDK（${specifier}）：${detail}`)
  }
}
