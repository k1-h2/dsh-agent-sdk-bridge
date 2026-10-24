/**
 * Each region's catalog must come from its own CLI user-data directory.
 *
 * The bundled CLI remembers its product environment inside that directory and
 * only switches it during initialize, after the model provider has already
 * chosen a catalog. Sharing the default directory between regions let a switch
 * read the other region's catalog, which was then cached for minutes: the page
 * showed the wrong model list, and the enabled/disabled choices written from
 * it belonged to the wrong region. These cases pin the isolation and the
 * single read per refresh.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  calls: [] as { environment: string, env?: Record<string, string> }[],
}))

// The CLI directory override is read per session, so it is enough to set it
// before the first test runs; the state path keeps the tests off the real file.
const root = mkdtempSync(join(tmpdir(), 'codebuddy-cli-'))
process.env.DSH_CODUBUDDY_CLI_DIR = root
process.env.DSH_CODUBUDDY_STATE_PATH = join(root, 'state.json')

vi.mock('../src/sdk.ts', () => ({
  codeBuddyEnvironment: (region: string) => region === 'cn' ? 'internal' : 'external',
  loadCodeBuddySdk: async () => ({
    unstable_v2_createSession: (options: { environment: string, env?: Record<string, string> }) => {
      fake.calls.push({ environment: options.environment, env: options.env })
      return {
        connect: async () => {},
        getAvailableModelsRaw: async () => [{ id: `${options.environment}-model`, name: 'Model' }],
        close: () => {},
      }
    },
  }),
}))

const { CodeBuddyCatalog } = await import('../src/codebuddy.ts')

afterAll(() => { rmSync(root, { recursive: true, force: true }) })

describe('CodeBuddy catalog isolation per region', () => {
  it('boots each region in its own directory and reads once', async () => {
    fake.calls.length = 0
    const catalog = new CodeBuddyCatalog(() => 'global')
    const global = await catalog.models('global')
    const cn = await catalog.models('cn')

    expect(global.map(model => model.id)).toEqual(['external-model'])
    expect(cn.map(model => model.id)).toEqual(['internal-model'])
    expect(fake.calls).toHaveLength(2)
    expect(fake.calls[0].environment).toBe('external')
    expect(fake.calls[1].environment).toBe('internal')
    // Distinct directories: the CLI's remembered environment is per directory,
    // so one region can never make the other read the wrong catalog.
    expect(fake.calls[0].env?.CODEBUDDY_CONFIG_DIR).toBe(join(root, 'global'))
    expect(fake.calls[1].env?.CODEBUDDY_CONFIG_DIR).toBe(join(root, 'cn'))
  })

  it('serves repeat reads from the cache instead of booting again', async () => {
    fake.calls.length = 0
    const catalog = new CodeBuddyCatalog(() => 'cn')
    await catalog.models('cn')
    await catalog.models('cn')
    expect(fake.calls).toHaveLength(1)
  })
})
