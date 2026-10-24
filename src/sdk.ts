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

import * as cnSdk from '@qodercn-ai/qodercn-agent-sdk'
import type * as QoderSdk from '@qodercn-ai/qodercn-agent-sdk'
import type * as CodeBuddySdk from '@tencent-ai/agent-sdk'
import type { CodeBuddyRegion, QoderBrand } from './brand.ts'
import { brandProfile, codeBuddyEnvironment } from './brand.ts'

/** The subset of the Qoder SDK surface this plugin uses, as one module type. */
export type QoderSdkModule = typeof QoderSdk
/** The CodeBuddy SDK module, typed from its declarations. */
export type CodeBuddySdkModule = typeof CodeBuddySdk

let globalSdk: Promise<QoderSdkModule> | undefined
let codeBuddySdk: Promise<CodeBuddySdkModule> | undefined

/**
 * Load the SDK for one Qoder edition.
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
 * at build time, which is exactly what an optional edition must not do.
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

/**
 * Load the CodeBuddy Agent SDK.
 *
 * Kept lazy because the package ships its own ~200 MB CLI and is useless to a
 * deployment that never enables CodeBuddy.
 */
export function loadCodeBuddySdk(): Promise<CodeBuddySdkModule> {
  codeBuddySdk ??= importCodeBuddySdk()
  return codeBuddySdk
}

async function importCodeBuddySdk(): Promise<CodeBuddySdkModule> {
  const specifier = brandProfile('codebuddy').sdkPackage
  try {
    return await import(/* @vite-ignore */ specifier) as CodeBuddySdkModule
  } catch (error) {
    codeBuddySdk = undefined
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`CodeBuddy SDK 不可用（${specifier}）：${detail}`)
  }
}

/** The SDK auth environment for a CodeBuddy login region. */
export { codeBuddyEnvironment }
export type { CodeBuddyRegion }
