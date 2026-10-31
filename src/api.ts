/**
 * The settings pages' data source, served same-origin.
 *
 * The pages cannot read the model catalog from the config form: the catalog is
 * fetched live from the provider, while the form only carries what the user
 * stored. So the host answers these JSON routes:
 *
 * - `GET <prefix>/models?brand=cn|global|codebuddy` — the account's models,
 *   each with its enabled state and the windows it may use.
 * - `GET <prefix>/usage?brand=...` — the account reading. Qoder returns quota;
 *   CodeBuddy returns the signed-in account (its SDK exposes no quota call).
 * - `GET/POST <prefix>/setup` — the Qoder CLI install/login/uninstall helper.
 * - `GET/POST <prefix>/auth` — CodeBuddy browser login/logout per region.
 *
 * Config writes deliberately do NOT come through here. The browser half holds
 * a revision-fenced form for this plugin's namespace (`ctx.configForms`), and
 * routing every change through it means one write path and one revision fence.
 *
 * @module dsh-agent-sdk-bridge/api
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { QoderAdapter } from './adapter.ts'
import type { CodeBuddyAdapter } from './codebuddy-adapter.ts'
import type { MinimaxAdapter } from './minimax-adapter.ts'
import type { BrandId, CodeBuddyRegion, MinimaxRegion } from './brand.ts'
import { isBrandId, isCodeBuddyRegion } from './brand.ts'
import { priceFactorOf } from './models.ts'
import { cancelSetup, isSetupMode, readSetupStatus, startSetup } from './setup.ts'
import { isMinimaxSetupMode, readMinimaxSetupStatus, startMinimaxSetup } from './minimax-cli.ts'

/** Route prefix this plugin owns; the client resolves it relative to the page. */
export const API_PREFIX = '/api/llm-qoder-cn'

/** One model row as a settings page renders it. */
export interface ModelRow {
  id: string
  name: string
  description?: string
  enabled: boolean
  vision: boolean
  contextWindow: number
  contextWindows: number[]
  defaultContextWindow: number
  override?: number
  priceFactor?: number
  reasoning: boolean
  /**
   * Whether the provider accepts a context-budget choice for this model.
   *
   * Absent (Qoder, MiniMax) means the ordinary menu applies. `false` means the
   * window is fixed upstream, so the page shows the value without a selector.
   */
  contextWindowSelectable?: boolean
}

/** The adapters the API can reach, one per provider route. */
export type AdapterMap = Readonly<Record<BrandId, QoderAdapter | CodeBuddyAdapter | MinimaxAdapter>>

/** Answer one request with JSON. */
function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Build model rows for a Qoder adapter. */
export async function buildRows(adapter: QoderAdapter): Promise<ModelRow[]> {
  const live = await adapter.describeCatalog()
  return live.map(entry => {
    const override = adapter.contextWindowFor(entry.value)
    const upstream = entry.defaultContextWindow
      ?? (entry.availableContextWindows !== undefined && entry.availableContextWindows.length > 0
        ? Math.max(...entry.availableContextWindows)
        : entry.maxInputTokens)
      ?? 200_000
    const choices = new Set<number>(entry.availableContextWindows ?? [])
    choices.add(upstream)
    if (override !== undefined) choices.add(override)
    const priceFactor = priceFactorOf(entry)
    return {
      id: entry.value,
      name: entry.displayName.length > 0 ? entry.displayName : entry.value,
      ...entry.description.length > 0 ? { description: entry.description } : {},
      enabled: !adapter.isModelDisabled(entry.value),
      vision: entry.isVl === true,
      contextWindow: override ?? upstream,
      contextWindows: [...choices].sort((a, b) => a - b),
      defaultContextWindow: upstream,
      ...override === undefined ? {} : { override },
      ...priceFactor === undefined ? {} : { priceFactor },
      reasoning: entry.isReasoning !== false,
      // One advertised window is a fixed window: the CLI ignores anything
      // else, so the page should show the value instead of a dead selector.
      contextWindowSelectable: (entry.availableContextWindows?.length ?? 0) > 1,
    }
  })
}

/** Build model rows for the CodeBuddy adapter, for one login region. */
export async function buildCodeBuddyRows(
  adapter: CodeBuddyAdapter,
  region?: CodeBuddyRegion,
): Promise<ModelRow[]> {
  const live = await adapter.describeCatalog(region)
  return live.map(entry => {
    // Only windows the provider accepts are offered. CodeBuddy validates
    // `set_config.contextWindow` against `contextWindow.supportedLengths` and
    // answers anything else with `Allowed: <none>`, so a menu entry the CLI
    // refuses would be a switch that does nothing upstream.
    const override = adapter.contextWindowFor(entry.id, region)
    const choices = new Set<number>(entry.contextWindows)
    if (override !== undefined) choices.add(override)
    return {
      id: entry.id,
      name: entry.name,
      ...entry.description === undefined ? {} : { description: entry.description },
      enabled: !adapter.isModelDisabled(entry.id, region),
      vision: entry.vision,
      contextWindow: override ?? entry.defaultContextWindow,
      contextWindows: [...choices].sort((a, b) => a - b),
      defaultContextWindow: entry.defaultContextWindow,
      ...override === undefined ? {} : { override },
      ...entry.priceFactor === undefined ? {} : { priceFactor: entry.priceFactor },
      reasoning: (entry.reasoningEfforts?.length ?? 0) > 0,
      contextWindowSelectable: entry.contextWindows.length > 0,
    }
  })
}

/** Build model rows for the MiniMax adapter, for one login region. */
export async function buildMinimaxRows(
  adapter: MinimaxAdapter,
  region?: MinimaxRegion,
): Promise<ModelRow[]> {
  const live = await adapter.describeCatalog(region)
  return live.map(entry => {
    const override = adapter.contextWindowFor(entry.id, region)
    const choices = new Set<number>(entry.contextWindows)
    choices.add(entry.defaultContextWindow)
    if (override !== undefined) choices.add(override)
    return {
      id: entry.id,
      name: entry.name,
      ...entry.description === undefined ? {} : { description: entry.description },
      enabled: !adapter.isModelDisabled(entry.id, region),
      vision: entry.vision,
      contextWindow: override ?? entry.defaultContextWindow,
      contextWindows: [...choices].sort((a, b) => a - b),
      defaultContextWindow: entry.defaultContextWindow,
      ...override === undefined ? {} : { override },
      reasoning: entry.reasoning,
    }
  })
}

/** Largest request body this route accepts. */
const MAX_BODY_BYTES = 2048

/** Read and parse a small JSON request body. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(String(part))
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') throw new Error('缺少请求体')
  return JSON.parse(text)
}

/** The brand a query-string or body selected, or undefined when it named none. */
function brandFrom(value: unknown): BrandId | undefined {
  if (value === null || value === undefined || value === '') return 'cn'
  return isBrandId(value) ? value : undefined
}

/** A CodeBuddy region from a query or body, defaulting to the international one. */
function regionFrom(value: unknown): CodeBuddyRegion | undefined {
  if (value === null || value === undefined || value === '') return 'global'
  return isCodeBuddyRegion(value) ? value : undefined
}

/** Handle one request under {@link API_PREFIX}. */
export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  adapters: AdapterMap,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.slice(API_PREFIX.length) || '/'
    const method = req.method ?? 'GET'
    const queryBrand = brandFrom(url.searchParams.get('brand'))

    if (queryBrand === undefined) {
      send(res, 400, { error: 'brand 只接受 cn、global、codebuddy 或 minimax' })
      return
    }
    const adapter = adapters[queryBrand]
    const codebuddy = queryBrand === 'codebuddy' ? adapter as CodeBuddyAdapter : undefined
    const minimax = queryBrand === 'minimax' ? adapter as MinimaxAdapter : undefined
    const regional = codebuddy !== undefined || minimax !== undefined

    if (path === '/models' && method === 'GET') {
      const requestedRegion = url.searchParams.get('region')
      const region = requestedRegion === null || requestedRegion === ''
        ? undefined
        : regionFrom(requestedRegion)
      if (regional && region === undefined && requestedRegion !== null && requestedRegion !== '') {
        send(res, 400, { error: 'region 只接受 global 或 cn' })
        return
      }
      if (url.searchParams.get('fresh') === '1') {
        if (codebuddy !== undefined) codebuddy.invalidateCatalog(region)
        else if (minimax !== undefined) minimax.invalidateCatalog(region)
        else adapter.invalidateCatalog()
      }
      const signedIn = codebuddy?.isSignedIn(region) ?? minimax?.isSignedIn(region)
      const rows = codebuddy !== undefined
        ? signedIn === false ? [] : await buildCodeBuddyRows(codebuddy, region)
        : minimax !== undefined
          ? signedIn === false ? [] : await buildMinimaxRows(minimax, region)
          : await buildRows(adapter as QoderAdapter)
      const notice = rows.length === 0
        ? codebuddy !== undefined
          ? codebuddy.catalogError(region)
          : minimax !== undefined ? minimax.catalogError(region) : adapter.catalogError()
        : undefined
      send(res, 200, {
        brand: queryBrand,
        models: rows,
        // Echo the region so the page can refuse a response that belongs to
        // the other login: a harmless extra field for the Qoder brands.
        ...region === undefined ? {} : { region },
        ...signedIn === undefined ? {} : { signedIn },
        ...minimax === undefined ? {} : { regionBlocked: minimax.regionBlocked(region) },
        ...notice === undefined ? {} : { notice },
      })
      return
    }

    if (path === '/usage' && method === 'GET') {
      const requested = url.searchParams.get('region')
      const region = requested === null || requested === '' ? undefined : regionFrom(requested)
      if (regional && region === undefined && requested !== null && requested !== '') {
        send(res, 400, { error: 'region 只接受 global 或 cn' })
        return
      }
      const fresh = url.searchParams.get('fresh') === '1'
      const snapshot = codebuddy !== undefined
        ? await codebuddy.usageInfo(fresh, region)
        : minimax !== undefined
          ? await minimax.usageInfo(fresh, region)
          : await adapter.usageInfo(fresh)
      send(res, 200, {
        brand: queryBrand,
        ...snapshot,
        ...codebuddy === undefined && minimax === undefined
          ? {}
          : { signedIn: (codebuddy ?? minimax)!.isSignedIn(region) },
      })
      return
    }

    if (path === '/auth') {
      if (method === 'GET') {
        if (codebuddy === undefined && minimax === undefined) {
          send(res, 404, { error: '该 provider 没有浏览器登录流程' })
          return
        }
        const region = regionFrom(url.searchParams.get('region'))
        if (region === undefined) {
          send(res, 400, { error: 'region 只接受 global 或 cn' })
          return
        }
        send(res, 200, codebuddy !== undefined
          ? { brand: 'codebuddy', ...codebuddy.authStatus(region) }
          : { brand: 'minimax', ...minimax!.authStatus(region) })
        return
      }
      if (method === 'POST') {
        let body: { brand?: unknown, region?: unknown, action?: unknown }
        try {
          body = ((await readJson(req)) ?? {}) as { brand?: unknown, region?: unknown, action?: unknown }
        } catch (error) {
          send(res, 400, { error: `请求体无法解析：${error instanceof Error ? error.message : String(error)}` })
          return
        }
        // A POST selects its provider in the body: the page never puts the
        // brand in the URL for writes.
        const postBrand = brandFrom(body.brand)
        if (postBrand !== 'codebuddy' && postBrand !== 'minimax') {
          send(res, 400, { error: '该 provider 没有浏览器登录流程' })
          return
        }
        const region = regionFrom(body.region)
        if (region === undefined) {
          send(res, 400, { error: 'region 只接受 global 或 cn' })
          return
        }
        if (body.action !== 'login' && body.action !== 'logout') {
          send(res, 400, { error: 'action 只接受 login 或 logout' })
          return
        }
        if (postBrand === 'codebuddy') {
          const cb = adapters.codebuddy as CodeBuddyAdapter
          if (body.action === 'logout') {
            const result = await cb.logout(region)
            if (!result.ok) {
              send(res, 500, { error: result.error })
              return
            }
            send(res, 200, { brand: 'codebuddy', ...cb.authStatus(region) })
            return
          }
          const started = cb.startLogin(region)
          if (started.started === false) {
            send(res, 409, { error: started.error })
            return
          }
          send(res, 200, { brand: 'codebuddy', ...cb.authStatus(region) })
          return
        }
        const mm = adapters.minimax as MinimaxAdapter
        if (body.action === 'logout') {
          send(res, 200, { brand: 'minimax', ...await mm.logout(region) })
          return
        }
        const started = mm.startLogin(region)
        if (started.started === false) {
          send(res, 409, { error: started.error })
          return
        }
        send(res, 200, { brand: 'minimax', ...mm.authStatus(region) })
        return
      }
    }

    if (path === '/setup') {
      if (method === 'GET') {
        if (codebuddy !== undefined) {
          send(res, 400, { error: 'CodeBuddy 不需要安装 CLI，请在页面中登录' })
          return
        }
        if (minimax !== undefined) {
          send(res, 200, readMinimaxSetupStatus())
          return
        }
        send(res, 200, readSetupStatus(queryBrand as 'cn' | 'global'))
        return
      }
      if (method === 'POST') {
        let parsed: { brand?: unknown, mode?: unknown }
        try {
          parsed = ((await readJson(req)) ?? {}) as { brand?: unknown, mode?: unknown }
        } catch (error) {
          send(res, 400, { error: `请求体无法解析：${error instanceof Error ? error.message : String(error)}` })
          return
        }
        // A POST selects its provider in the body; the query string may name
        // none at all, which is why this cannot reuse the GET's brand.
        const postBrand = brandFrom(parsed.brand)
        if (postBrand === undefined) {
          send(res, 400, { error: 'brand 只接受 cn、global、codebuddy 或 minimax' })
          return
        }
        if (postBrand === 'codebuddy') {
          send(res, 400, { error: 'CodeBuddy 不需要安装 CLI，请在页面中登录' })
          return
        }
        if (postBrand === 'minimax') {
          if (!isMinimaxSetupMode(parsed.mode)) {
            send(res, 400, { error: 'mode 只接受 install 或 uninstall' })
            return
          }
          const mm = adapters.minimax as MinimaxAdapter
          const result = startMinimaxSetup(parsed.mode, code => {
            if (code !== 0) return
            mm.invalidateCatalog()
            mm.invalidateUsage()
          })
          if (!result.started) {
            send(res, result.reason === 'busy' ? 409 : 501, { error: result.error })
            return
          }
          send(res, 200, readMinimaxSetupStatus())
          return
        }
        if (parsed.mode === 'cancel') {
          cancelSetup(postBrand)
          send(res, 200, readSetupStatus(postBrand))
          return
        }
        if (!isSetupMode(parsed.mode)) {
          send(res, 400, { error: 'mode 只接受 configure、login、logout、uninstall 或 cancel' })
          return
        }
        const qoder = adapters[postBrand] as QoderAdapter
        const mode = parsed.mode
        const result = startSetup(postBrand, mode, code => {
          if (code !== 0) return
          qoder.invalidateCatalog()
          qoder.invalidateUsage()
          // A warm session owns a CLI process that loaded its credentials at
          // start-up; after a sign-out it would keep answering as the account
          // that just left. Dropping them makes the next turn start clean.
          if (mode === 'logout') qoder.closeSessions()
        })
        if (!result.started) {
          const status = result.reason === 'busy' ? 409 : result.reason === 'unsupported' ? 501 : 500
          send(res, status, { error: result.error })
          return
        }
        send(res, 200, readSetupStatus(postBrand))
        return
      }
      send(res, 405, { error: '不支持的写入路径' })
      return
    }

    send(res, method === 'GET' ? 404 : 405, { error: method === 'GET' ? 'not found' : '不支持的写入路径' })
  } catch (error) {
    send(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}
