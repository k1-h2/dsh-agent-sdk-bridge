/**
 * The SDK keeps one process-wide daemon per edition and refuses a different
 * launch configuration once it is ready. A long-lived host outlives that
 * configuration, so the plugin has to notice the conflict and take a fresh
 * instance instead of failing every later query until a restart.
 *
 * These cases cover the pure parts: the error shape, the message the page
 * shows, the retry contract, and the signature that decides when a new
 * instance is needed.
 */
import { describe, expect, it } from 'vitest'
import { cliFailureText } from '../src/cli.ts'
import { configurationSignature, isDaemonConflict, withSdk } from '../src/sdk.ts'

/** The exact error the SDK raises when the daemon was initialized differently. */
function conflict(): Error {
  const error = new Error('Global daemon is already initialized with different options')
  error.name = 'DaemonConfigurationConflictError'
  return error
}

describe('SDK daemon recovery', () => {
  it('recognizes the conflict by name or by message', () => {
    expect(isDaemonConflict(conflict())).toBe(true)
    expect(isDaemonConflict(new Error('Global daemon is already initialized with different options'))).toBe(true)
    expect(isDaemonConflict(new Error('socket hang up'))).toBe(false)
    expect(isDaemonConflict('not an error')).toBe(false)
  })

  it('turns the conflict into an actionable message', () => {
    const text = cliFailureText(`DaemonConfigurationConflictError: ${conflict().message}`, 'cn')
    expect(text).toContain('qoderclicn')
    expect(text).toContain('重试')
    // The raw English error stays available for a bug report.
    expect(text).toContain('already initialized')
  })

  it('retries an idempotent read once against a fresh instance', async () => {
    let calls = 0
    await expect(withSdk('cn', async () => {
      calls += 1
      throw conflict()
    })).rejects.toThrow(/already initialized/)
    expect(calls).toBe(2)
  })

  it('does not retry an unrelated failure', async () => {
    let calls = 0
    await expect(withSdk('cn', async () => {
      calls += 1
      throw new Error('network down')
    })).rejects.toThrow('network down')
    expect(calls).toBe(1)
  })

  it('changes its signature exactly when the launch configuration does', () => {
    expect(configurationSignature('cn')).toBe(configurationSignature('cn'))

    // A brand-specific CLI override is part of what the daemon compares, so a
    // new value must force a new instance.
    const before = configurationSignature('cn')
    const previous = process.env.QODERCN_CLI_PATH
    process.env.QODERCN_CLI_PATH = 'C:/probe/another/qoderclicn.js'
    try {
      expect(configurationSignature('cn')).not.toBe(before)
    } finally {
      if (previous === undefined) delete process.env.QODERCN_CLI_PATH
      else process.env.QODERCN_CLI_PATH = previous
    }
    expect(configurationSignature('cn')).toBe(before)
  })
})
