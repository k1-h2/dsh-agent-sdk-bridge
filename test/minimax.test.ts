/**
 * MiniMax Code helpers that do not need the real CLI.
 *
 * The ACP session itself is exercised against `mcode acp` by the live probe;
 * these cases cover the pure translation layers the settings page and the
 * adapter rely on: config-option parsing, the MCP tool namespace, auth-state
 * reading, CLI discovery, and the HTTP MCP bridge the CLI calls.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MinimaxMcpBridge, MinimaxMcpServer, hostMcpToolName, isHostMcpTool,
  minimaxAuthStatePath, minimaxDataDir, minimaxModelsFromConfigOptions, minimaxSignedIn,
  minimaxUsageFromParts, minimaxUsage, minimaxHostBelongsToOtherRegion,
  minimaxRegionBlocked, minimaxRegionBlockedCached,
  invalidateMinimaxRegionAccess, invalidateMinimaxUsage,
} from '../src/minimax.ts'
import { resolveMinimaxCli, minimaxCliArgs } from '../src/minimax-cli.ts'
import { resolveMinimaxModelId } from '../src/minimax-adapter.ts'

const RESTORE: (() => void)[] = []

function scope(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-minimax-test-'))
  RESTORE.push(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

function setEnv(name: string, value: string | undefined): void {
  const previous = process.env[name]
  RESTORE.push(() => {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  })
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

afterEach(() => {
  while (RESTORE.length > 0) RESTORE.pop()?.()
})

describe('MiniMax model catalog', () => {
  const OPTIONS = [
    {
      id: 'model', category: 'model', currentValue: 'm:minimax:MiniMax-M3:v:thinking',
      options: [
        { value: 'm:minimax:MiniMax-M3.1-Flash:v:', name: 'M3.1-Flash' },
        { value: 'm:minimax:MiniMax-M3.1-Flash:v:thinking', name: 'M3.1-Flash · thinking' },
        { value: 'm:minimax:MiniMax-M3:v:thinking', name: 'M3 · thinking', description: 'deep' },
        { value: 'm:minimax:MiniMax-M3.1-Flash:v:', name: 'duplicate' },
      ],
    },
    {
      id: 'thinkingEffort', category: 'thought_level', currentValue: 'default',
      options: [{ value: 'default' }, { value: 'low' }, { value: 'high' }],
    },
  ]

  it('turns the model config option into de-duplicated rows', () => {
    const models = minimaxModelsFromConfigOptions(OPTIONS)
    expect(models.map(model => model.id)).toEqual([
      'm:minimax:MiniMax-M3.1-Flash:v:',
      'm:minimax:MiniMax-M3.1-Flash:v:thinking',
      'm:minimax:MiniMax-M3:v:thinking',
    ])
    expect(models[0]).toMatchObject({
      name: 'M3.1-Flash',
      vision: true,
      reasoning: true,
      reasoningEfforts: ['low', 'high'],
      defaultContextWindow: 512_000,
    })
    expect(models[2].description).toBe('deep')
  })

  it('reports no reasoning when the CLI offers no effort options', () => {
    const models = minimaxModelsFromConfigOptions([OPTIONS[0]])
    expect(models[0].reasoning).toBe(false)
    expect(models[0].reasoningEfforts).toEqual([])
  })

  it('survives a malformed or missing config option list', () => {
    expect(minimaxModelsFromConfigOptions(undefined)).toEqual([])
    expect(minimaxModelsFromConfigOptions([])).toEqual([])
    expect(minimaxModelsFromConfigOptions([{ id: 'model', options: 'nope' }])).toEqual([])
    expect(minimaxModelsFromConfigOptions([{ id: 'model', options: [{ value: 1 }] }])).toEqual([])
  })
})

describe('MiniMax tool namespace', () => {
  it('recognises the namespaced host tools the CLI emits', () => {
    expect(isHostMcpTool('mcp__dsh-host__ops_bash')).toBe(true)
    expect(isHostMcpTool('mcp__dsh_host__ops_bash')).toBe(true)
    expect(hostMcpToolName('mcp__dsh-host__ops_bash')).toBe('ops_bash')
    expect(hostMcpToolName('mcp__dsh_host__read')).toBe('read')
  })

  it('does not mistake built-in tools for host tools', () => {
    expect(isHostMcpTool('bash')).toBe(false)
    expect(isHostMcpTool('read')).toBe(false)
    expect(isHostMcpTool('mcp__other__read')).toBe(false)
    expect(hostMcpToolName('bash')).toBe('bash')
  })
})

describe('MiniMax model id mapping', () => {
  it('prefers an explicit alias and otherwise strips the provider prefix', () => {
    expect(resolveMinimaxModelId('minimax-M3', { 'minimax-M3': 'm:minimax:MiniMax-M3:v:' }))
      .toBe('m:minimax:MiniMax-M3:v:')
    expect(resolveMinimaxModelId('minimax-m3', { 'minimax-m3': 'm:minimax:MiniMax-M3:v:' }))
      .toBe('m:minimax:MiniMax-M3:v:')
    expect(resolveMinimaxModelId('minimax-M3')).toBe('M3')
    expect(resolveMinimaxModelId('m:minimax:MiniMax-M3:v:')).toBe('m:minimax:MiniMax-M3:v:')
  })
})

describe('MiniMax per-region state', () => {
  it('pins the data directory and the per-region auth file', () => {
    const dir = scope()
    setEnv('MINIMAX_DATA_DIR', dir)
    setEnv('MAVIS_DATA_DIR', undefined)
    setEnv('MAVIS_BUILD_ENV', undefined)
    expect(minimaxDataDir()).toBe(dir)
    expect(minimaxAuthStatePath('cn')).toBe(join(dir, 'auth', 'prod', 'cn', 'mcode-public', 'auth-state.json'))
    expect(minimaxAuthStatePath('global')).toBe(join(dir, 'auth', 'prod', 'en', 'mcode-public', 'auth-state.json'))
  })

  it('treats only an authenticated state file as signed in, per region', () => {
    const dir = scope()
    setEnv('MINIMAX_DATA_DIR', dir)
    const write = (region: 'cn' | 'en', body: unknown): void => {
      const path = join(dir, 'auth', 'prod', region, 'mcode-public', 'auth-state.json')
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, JSON.stringify(body), 'utf8')
    }
    expect(minimaxSignedIn('cn')).toBe(false)
    write('cn', { status: 'authenticated', expiresAtMs: 123, region: 'cn' })
    expect(minimaxSignedIn('cn')).toBe(true)
    expect(minimaxSignedIn('global')).toBe(false)
    // A file whose recorded region does not match its path is not this
    // region's credential, even if it says authenticated.
    write('en', { status: 'authenticated', region: 'cn' })
    expect(minimaxSignedIn('global')).toBe(false)
    write('en', { status: 'expired', region: 'en' })
    expect(minimaxSignedIn('global')).toBe(false)
  })
})

describe('MiniMax account and quota snapshot', () => {
  const USER_INFO = {
    name: 'MiniMax061286',
    avatar: 'https://example.test/a.png',
    userID: 'jp3P3Aj9nR58',
    realUserID: '509665762244173832',
  }
  const WORKSPACES = [{
    workspace_id: 0,
    workspace_type: 0,
    has_token_plan: true,
    op_group_id: '2053128250695098517',
    opcredit_balance: 0,
  }]
  const TOKEN_PLAN_MEMBERSHIP = {
    has_token_plan: true,
    token_plan_tier: 'pro',
    token_plan_expires_at: 1_800_000_000_000,
    op_group_id: '2053128250695098517',
    op_credit_summary: { total_remaining_amount: '12.5', purchased_remaining_amount: '0', free_remaining_amount: '12.5' },
  }
  const REMAINS = {
    base_resp: { status_code: 0, status_msg: 'success' },
    model_remains: [
      {
        model_name: 'general',
        current_interval_status: 1,
        current_interval_remaining_percent: 76,
        current_interval_usage_count: 240,
        current_interval_total_count: 1000,
        current_weekly_remaining_percent: 42,
        current_weekly_status: 1,
        end_time: 1_800_000_100_000,
        weekly_end_time: 1_800_500_000_000,
      },
      {
        model_name: 'video',
        current_interval_status: 3,
        current_interval_usage_count: 12,
        current_interval_total_count: 100,
        end_time: 1_800_000_200_000,
      },
    ],
  }

  it('maps a Token Plan account to its windows and credit balance', () => {
    const snapshot = minimaxUsageFromParts({
      region: 'cn',
      at: 1,
      userInfo: USER_INFO,
      workspaces: WORKSPACES,
      membership: TOKEN_PLAN_MEMBERSHIP,
      remains: REMAINS,
    })
    expect(snapshot).toMatchObject({
      at: 1,
      region: 'cn',
      signedIn: true,
      installed: true,
      account: { name: 'MiniMax061286', userId: 'jp3P3Aj9nR58', avatar: 'https://example.test/a.png' },
      plan: { kind: 'token-plan', hasTokenPlan: true, tier: 'pro', expiresAt: 1_800_000_000_000 },
      credits: { remaining: 12.5, purchasedRemaining: 0, freeRemaining: 12.5 },
    })
    expect(snapshot.windows?.map(window => window.id)).toEqual(['general:5h', 'general:7d', 'video:5h'])
    expect(snapshot.windows?.[0]).toMatchObject({
      label: '通用 · 5 小时',
      remainingPercent: 76,
      resetAt: 1_800_000_100_000,
      unlimited: false,
      remainingCount: 240,
      totalCount: 1000,
    })
    expect(snapshot.windows?.[2]).toMatchObject({ unlimited: true })
    // An unlimited window has no percentage to draw.
    expect(snapshot.windows?.[2].remainingPercent).toBeUndefined()
  })

  it('reports a credit account without inventing quota windows', () => {
    const snapshot = minimaxUsageFromParts({
      region: 'cn',
      userInfo: USER_INFO,
      workspaces: [{ ...WORKSPACES[0], has_token_plan: false }],
      membership: {
        has_token_plan: false,
        subscription_type: 'none',
        op_credit_summary: { total_remaining_amount: '2149.988' },
      },
      // A non-subscriber's remains endpoint answers 2062, not windows.
      remains: { base_resp: { status_code: 2062, status_msg: 'no active token plan subscription' }, model_remains: null },
    })
    expect(snapshot.plan).toMatchObject({ kind: 'credits', hasTokenPlan: false, subscriptionType: 'none' })
    expect(snapshot.credits).toMatchObject({ remaining: 2149.988 })
    expect(snapshot.windows).toBeUndefined()
  })

  it('falls back to the workspace balance and free plan when membership is sparse', () => {
    const snapshot = minimaxUsageFromParts({
      region: 'global',
      userInfo: { email: 'user@example.test' },
      workspaces: [{ workspace_type: 0, opcredit_balance: 0, has_token_plan: false }],
      membership: {},
    })
    expect(snapshot.plan).toMatchObject({ kind: 'free', hasTokenPlan: false })
    expect(snapshot.credits).toMatchObject({ remaining: 0 })
    expect(snapshot.account?.email).toBe('user@example.test')
    expect(snapshot.windows).toBeUndefined()
  })

  it('omits windows a rejection response or an empty bucket list would produce', () => {
    const empty = minimaxUsageFromParts({
      region: 'cn',
      membership: { has_token_plan: true },
      remains: { base_resp: { status_code: 0 }, model_remains: [] },
    })
    expect(empty.windows).toBeUndefined()

    const rejected = minimaxUsageFromParts({
      region: 'cn',
      membership: { has_token_plan: true },
      remains: { base_resp: { status_code: 1004, status_msg: 'login fail' }, model_remains: [] },
    })
    expect(rejected.windows).toBeUndefined()
  })
})

function writeMiniMaxAuth(dir: string, region: 'cn' | 'en', token = 'mmoat-test'): void {
  const base = join(dir, 'auth', 'prod', region, 'mcode-public')
  mkdirSync(base, { recursive: true })
  writeFileSync(join(base, 'auth.json'), JSON.stringify({
    records: { 'com.minimax.mcode.oauth.prod.test': { accessToken: token } },
  }), 'utf8')
  writeFileSync(join(base, 'auth-state.json'), JSON.stringify({
    status: 'authenticated',
    region,
  }), 'utf8')
}

describe('MiniMax region availability', () => {
  it('recognises the edge redirect between the two sites', () => {
    expect(minimaxHostBelongsToOtherRegion('global', 'https://agent.minimaxi.com/')).toBe(true)
    expect(minimaxHostBelongsToOtherRegion('global', 'https://platform.minimaxi.com/x')).toBe(true)
    expect(minimaxHostBelongsToOtherRegion('global', 'https://agent.minimax.io/')).toBe(false)
    expect(minimaxHostBelongsToOtherRegion('cn', 'https://platform.minimax.io/')).toBe(true)
    expect(minimaxHostBelongsToOtherRegion('cn', 'https://www.minimaxi.com/')).toBe(false)
    expect(minimaxHostBelongsToOtherRegion('global', 'not a url')).toBe(false)
  })

  it('keeps a verdict until a fresh probe asks again', async () => {
    invalidateMinimaxRegionAccess()
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return calls === 1
        ? new Response(null, { status: 307, headers: { location: 'https://agent.minimaxi.com/' } })
        : new Response(null, { status: 200 })
    }) as unknown as typeof fetch

    expect(await minimaxRegionBlocked('global', { fetchImpl })).toBe(true)
    expect(minimaxRegionBlockedCached('global')).toBe(true)
    // The cached verdict is what a normal read sees; no second request.
    expect(await minimaxRegionBlocked('global', { fetchImpl })).toBe(true)
    expect(calls).toBe(1)
    // A switch must re-probe, because the network may have changed.
    expect(await minimaxRegionBlocked('global', { fetchImpl, fresh: true })).toBe(false)
    expect(calls).toBe(2)
    expect(minimaxRegionBlockedCached('global')).toBe(false)
    invalidateMinimaxRegionAccess()
  })

  it('shares one probe between concurrent readers', async () => {
    invalidateMinimaxRegionAccess()
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      await new Promise(resolve => setTimeout(resolve, 5))
      return new Response(null, { status: 307, headers: { location: 'https://agent.minimaxi.com/' } })
    }) as unknown as typeof fetch

    // The quota read and the catalog read start together on a region switch.
    const [first, second] = await Promise.all([
      minimaxRegionBlocked('global', { fetchImpl, fresh: true }),
      minimaxRegionBlocked('global', { fetchImpl }),
    ])
    expect(first).toBe(true)
    expect(second).toBe(true)
    expect(calls).toBe(1)
    invalidateMinimaxRegionAccess()
  })

  it('reports a blocked region without inventing account data', async () => {
    const dir = scope()
    setEnv('MINIMAX_DATA_DIR', dir)
    setEnv('MAVIS_BUILD_ENV', undefined)
    writeMiniMaxAuth(dir, 'en')
    invalidateMinimaxUsage()
    invalidateMinimaxRegionAccess()
    const calls: string[] = []
    const fetchImpl = (async input => {
      const url = String(input)
      calls.push(url)
      if (new URL(url).pathname === '/') {
        return new Response(null, { status: 307, headers: { location: 'https://agent.minimaxi.com/' } })
      }
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch

    const snapshot = await minimaxUsage('global', { fresh: true, fetchImpl })

    expect(snapshot).toMatchObject({ region: 'global', signedIn: true, regionBlocked: true })
    expect(snapshot.error).toContain('IP')
    expect(snapshot.account).toBeUndefined()
    expect(snapshot.plan).toBeUndefined()
    expect(snapshot.credits).toBeUndefined()
    expect(snapshot.windows).toBeUndefined()
    // The probe is enough; no account endpoint is called after a refusal.
    expect(calls).toHaveLength(1)
    invalidateMinimaxRegionAccess()
    invalidateMinimaxUsage()
  })

  it('turns an account-endpoint redirect into the same verdict', async () => {
    const dir = scope()
    setEnv('MINIMAX_DATA_DIR', dir)
    setEnv('MAVIS_BUILD_ENV', undefined)
    writeMiniMaxAuth(dir, 'en')
    invalidateMinimaxUsage()
    invalidateMinimaxRegionAccess()
    const calls: string[] = []
    const fetchImpl = (async input => {
      const url = String(input)
      calls.push(url)
      const parsed = new URL(url)
      if (parsed.pathname === '/') return new Response(null, { status: 200 })
      if (parsed.pathname === '/v1/api/user/info') {
        return new Response(null, {
          status: 307,
          headers: { location: 'https://agent.minimaxi.com/v1/api/user/info' },
        })
      }
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch

    const snapshot = await minimaxUsage('global', { fresh: true, fetchImpl })

    expect(snapshot).toMatchObject({ region: 'global', signedIn: true, regionBlocked: true })
    expect(snapshot.error).toContain('IP')
    expect(snapshot.account).toBeUndefined()
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls[1]).toContain('/v1/api/user/info')
    invalidateMinimaxRegionAccess()
    invalidateMinimaxUsage()
  })
})

describe('MiniMax CLI discovery', () => {
  it('accepts an explicit cli.js override and spawns it through node', () => {
    const dir = scope()
    const entry = join(dir, 'cli.js')
    writeFileSync(entry, 'console.log("mcode")', 'utf8')
    setEnv('MCODE_CLI_PATH', entry)
    const spec = resolveMinimaxCli()
    expect(spec).toEqual({ command: process.execPath, args: [entry], cliPath: entry })
    expect(minimaxCliArgs(spec!, ['acp'])).toEqual([entry, 'acp'])
  })
})

describe('MiniMax MCP bridge', () => {
  it('lists the host schemas and forwards calls', async () => {
    const calls: { name: string, args: Record<string, unknown> }[] = []
    const bridge = new MinimaxMcpBridge(async (name, args) => {
      calls.push({ name, args })
      return { content: [{ type: 'text', text: `${name}:${String(args.msg)}` }] }
    })
    bridge.setTools([
      { name: 'ops_a', description: '', parameters: { type: 'object', properties: { msg: { type: 'string' } } } },
      { name: 'ops_b', description: 'B' },
    ])
    expect(bridge.tools()).toEqual([
      {
        name: 'ops_a',
        description: 'ops_a',
        inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
      },
      { name: 'ops_b', description: 'B', inputSchema: { type: 'object', properties: {} } },
    ])
    await bridge.call('ops_a', { msg: 'ping' })
    expect(calls).toEqual([{ name: 'ops_a', args: { msg: 'ping' } }])
    expect(await bridge.call('ops_missing', {})).toMatchObject({ isError: true })
    expect(calls).toHaveLength(1)
  })

  it('serves JSON-RPC over the loopback HTTP endpoint', async () => {
    const calls: string[] = []
    const server = new MinimaxMcpServer()
    await server.start()
    const bridge = new MinimaxMcpBridge(async name => {
      calls.push(name)
      return { content: [{ type: 'text', text: 'pong' }] }
    })
    bridge.setTools([{ name: 'ops_a', description: 'A', parameters: { type: 'object', properties: {} } }])
    const { url, token } = server.register(bridge)

    const post = (body: unknown, authorization = `Bearer ${token}`): Promise<Response> =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization },
        body: JSON.stringify(body),
      })

    try {
      const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
      expect(init.status).toBe(200)
      expect(await init.json()).toMatchObject({ id: 1, result: { capabilities: { tools: {} } } })

      const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
      expect(await list.json()).toMatchObject({ id: 2, result: { tools: [{ name: 'ops_a', description: 'A' }] } })

      const call = await post({
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'ops_a', arguments: { msg: 'ping' } },
      })
      expect(await call.json()).toMatchObject({
        id: 3,
        result: { content: [{ type: 'text', text: 'pong' }] },
      })
      expect(calls).toEqual(['ops_a'])

      // The bearer token is the only thing keeping another local process out.
      const denied = await post({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, 'Bearer wrong')
      expect(denied.status).toBe(403)
      const missing = await post({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, '')
      expect(missing.status).toBe(403)

      // An unregistered path is refused, not forwarded.
      const unknown = await fetch(new URL('/mcp/0000', server.baseUrl!), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' }),
      })
      expect(unknown.status).toBe(404)
    } finally {
      server.unregister(token)
      server.close()
    }
  })
})
