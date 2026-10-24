/**
 * The CLI helper's server half: where the script lives, what the page may ask
 * for, and whether a real run actually produces output.
 *
 * The end-to-end case is Windows-only because the helper is a batch file. It
 * asserts on the *plumbing* — the run settles, its exit code is a number, and
 * the first step printed — rather than on a successful configuration, since the
 * machine running the tests may legitimately have no CLI installed.
 */

import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  SCRIPT_NAME, isSetupMode, readSetupStatus, setupScriptPath, startSetup,
} from '../src/setup.ts'
import { brandProfile } from '../src/brand.ts'

describe('setup helper', () => {
  it('finds the shipped script from this package layout', () => {
    const script = setupScriptPath('cn')
    expect(script).toBeDefined()
    expect(script!.endsWith(`scripts${process.platform === 'win32' ? '\\' : '/'}${SCRIPT_NAME}`)).toBe(true)
    expect(existsSync(script!)).toBe(true)
  })

  it('ships a helper for each edition', () => {
    for (const id of ['cn', 'global'] as const) {
      const script = setupScriptPath(id)
      expect(script, id).toBeDefined()
      expect(existsSync(script!), id).toBe(true)
      expect(script!.endsWith(brandProfile(id).setupScript)).toBe(true)
    }
  })

  it('accepts only the modes it can name a flag for', () => {
    expect(isSetupMode('configure')).toBe(true)
    expect(isSetupMode('login')).toBe(true)
    expect(isSetupMode('uninstall')).toBe(true)
    for (const value of [undefined, null, '', 'CONFIGURE', '--gui', 'check', '--check', 'install && calc', {}]) {
      expect(isSetupMode(value)).toBe(false)
    }
  })

  it('answers an empty status before anything has run', () => {
    const status = readSetupStatus('cn')
    expect(status.running).toBe(false)
    expect(status.lines).toEqual([])
    expect(status.truncated).toBe(false)
  })

  const windows = process.platform === 'win32'
  it(windows ? 'runs the batch file and reports its output' : 'refuses to run off Windows', async () => {
    const started = startSetup('cn', 'configure')
    if (!windows) {
      expect(started).toMatchObject({ started: false, reason: 'unsupported' })
      return
    }
    expect(started.started).toBe(true)

    // A second request must be refused while the first one is still alive.
    expect(startSetup('cn', 'configure')).toMatchObject({ started: false, reason: 'busy' })

    const deadline = Date.now() + 120_000
    while (readSetupStatus('cn').running && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    const status = readSetupStatus('cn')
    expect(status.running).toBe(false)
    expect(typeof status.code).toBe('number')
    expect(status.lines.join('\n')).toContain('[1/5]')
  }, 150_000)
})
