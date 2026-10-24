/**
 * The settings page's data source, served same-origin.
 *
 * The page cannot read the model catalog from the config form: the catalog is
 * fetched live from the Qoder CLI, while the form only carries what the user
 * stored. So the host answers these JSON routes:
 *
 * - `GET <prefix>/models?brand=cn|global` — every model that account exposes,
 *   each with its enabled state, the window it will use, and the windows it may
 *   use.
 * - `GET <prefix>/usage?brand=cn|global[&fresh=1]` — the account's quota and
 *   usage, as the Qoder clients display them.
 * - `GET <prefix>/setup?brand=cn|global` — state of that edition's CLI helper
 *   run, including what it printed.
 * - `POST <prefix>/setup` — start that helper:
 *   `{"brand":"cn"|"global","mode":"configure"|"login"}`.
 *
 * Both editions answer through the same routes because the page and the host
 * are one origin; the `brand` parameter selects which adapter answers, and an
 * unknown value is refused rather than defaulted, so a typo cannot silently
 * read the other account's data.
 *
 * Config writes deliberately do NOT come through here. The browser half already
 * holds a revision-fenced form for this plugin's config namespace
 * (`ctx.configForms.get(ns)`), and routing every change through it means one
 * write path, one revision fence, and no second owner of the same document. A
 * host-side write would have to reach into the settings service and could race
 * the form. The `/setup` pair is not a config write: it starts a bundled script
 * and reports its output.
 *
 * @module dsh-qoder-link/api
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { QoderAdapter } from './adapter.ts'
import type { QoderBrand } from './brand.ts'
import { isQoderBrand } from './brand.ts'
import { priceFactorOf } from './models.ts'
import { isSetupMode, readSetupStatus, startSetup } from './setup.ts'

/** Route prefix this plugin owns; the client resolves it relative to the page. */
export const API_PREFIX = '/api/llm-qoder-cn'

/** One model row as the page renders it. */
interface ModelRow {
  /** Qoder model id, the identity every write uses. */
  id: string
  /** Display name. */
  name: string
  /** Model description, when upstream provides one. */
  description?: string
  /** Whether the user currently allows this model in the picker. */
  enabled: boolean
  /** Whether the model accepts image input. */
  vision: boolean
  /** Window the requests will actually use, in tokens. */
  contextWindow: number
  /** Windows the user may choose from, ascending. Always contains the current one. */
  contextWindows: number[]
  /** Upstream's own window for this model, i.e. what "default" means here. */
  defaultContextWindow: number
  /** The user's explicit choice, or undefined when following upstream. */
  override?: number
  /**
   * Credit multiplier upstream quotes for this model; `0` means free. Absent
   * when upstream quoted none, so the page shows no suffix rather than a
   * fabricated one.
   */
  priceFactor?: number
  /** Whether the model supports a reasoning-effort choice. */
  reasoning: boolean
}

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

/**
 * Build the model rows: the live catalog joined with the user's choices.
 *
 * @param adapter - the adapter owning the live catalog and the resolved config.
 * @returns one row per model the account exposes, in catalog order.
 */
export async function buildRows(adapter: QoderAdapter): Promise<ModelRow[]> {
  const live = await adapter.describeCatalog()
  return live.map(entry => {
    const override = adapter.contextWindowFor(entry.value)
    const upstream = entry.defaultContextWindow
      ?? (entry.availableContextWindows !== undefined && entry.availableContextWindows.length > 0
        ? Math.max(...entry.availableContextWindows)
        : entry.maxInputTokens)
      ?? 200_000
    // Offer upstream's declared windows, plus the effective one so the select
    // never shows a value it cannot re-select.
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
    }
  })
}

/**
 * Largest request body this route accepts. The only body in the API is a
 * two-key JSON object, so anything bigger is either a bug or an attack.
 */
const MAX_BODY_BYTES = 1024

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
function brandFrom(value: unknown): QoderBrand | undefined {
  if (value === null || value === undefined || value === '') return 'cn'
  return isQoderBrand(value) ? value : undefined
}

/**
 * Handle one request under {@link API_PREFIX}.
 *
 * @param req - the incoming request.
 * @param res - the response this handler owns.
 * @param adapters - one adapter per edition; `brand` selects which answers.
 */
export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  adapters: Readonly<Record<QoderBrand, QoderAdapter>>,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.slice(API_PREFIX.length) || '/'
    const method = req.method ?? 'GET'
    const queryBrand = brandFrom(url.searchParams.get('brand'))

    if (queryBrand === undefined) {
      send(res, 400, { error: 'brand 只接受 cn 或 global' })
      return
    }
    const adapter = adapters[queryBrand]

    if (path === '/models' && method === 'GET') {
      // `?fresh=1` is the page's refresh button. The cached list is precisely
      // what a user wants to escape once the CLI's own state just changed.
      if (url.searchParams.get('fresh') === '1') adapter.invalidateCatalog()
      const models = await buildRows(adapter)
      // An empty list with a reason is a configuration problem the page can
      // explain (missing SDK, signed-out CLI); an empty list alone is not.
      const notice = models.length === 0 ? adapter.catalogError() : undefined
      send(res, 200, { brand: queryBrand, models, ...notice === undefined ? {} : { notice } })
      return
    }

    if (path === '/usage' && method === 'GET') {
      const snapshot = await adapter.usageInfo(url.searchParams.get('fresh') === '1')
      send(res, 200, { brand: queryBrand, ...snapshot })
      return
    }

    if (path === '/setup') {
      if (method === 'GET') {
        send(res, 200, readSetupStatus(queryBrand))
        return
      }
      if (method === 'POST') {
        let body: unknown
        try {
          body = (await readJson(req) as { brand?: unknown, mode?: unknown } | null) ?? {}
        } catch (error) {
          send(res, 400, { error: `请求体无法解析：${error instanceof Error ? error.message : String(error)}` })
          return
        }
        const parsed = body as { brand?: unknown, mode?: unknown }
        const postBrand = brandFrom(parsed.brand)
        if (postBrand === undefined) {
          send(res, 400, { error: 'brand 只接受 cn 或 global' })
          return
        }
        if (!isSetupMode(parsed.mode)) {
          send(res, 400, { error: 'mode 只接受 configure、login 或 uninstall' })
          return
        }
        const result = startSetup(postBrand, parsed.mode, code => {
          // A run that installed or signed into the CLI changed what the catalog
          // should hold, and an empty catalog is cached like any other answer.
          if (code === 0) {
            adapters[postBrand].invalidateCatalog()
            adapters[postBrand].invalidateUsage()
          }
        })
        if (!result.started) {
          const status = result.reason === 'busy' ? 409 : result.reason === 'unsupported' ? 501 : 500
          send(res, status, { error: result.error })
          return
        }
        send(res, 200, readSetupStatus(postBrand))
        return
      }
    }

    send(res, method === 'GET' ? 404 : 405, { error: method === 'GET' ? 'not found' : '只支持读取，以及 POST /setup' })
  } catch (error) {
    send(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}
