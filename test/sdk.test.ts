/**
 * The SDK keeps one process-wide daemon per edition, pinned to the launch
 * configuration of its first query. A long-lived host outlives that
 * configuration — the CLI updates itself, an edition appears, credentials are
 * refreshed — and from then on every query is refused until the process
 * restarts. The plugin therefore freezes the configuration it sends and resets
 * the daemon through the SDK's own `shutdownDaemon()`.
 *
 * These cases cover the pure parts: the error shape, the message the page
 * shows, the retry contract, and the fact that the configuration is frozen
 * until a reset asks for it to be recomputed.
 */
import { describe, expect, it } from 'vitest'
import { cliFailureText } from '../src/cli.ts'
import { configurationSignature, isDaemonConflict, resetDaemon, withSdk } from '../src/sdk.ts'

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

  it('retries an idempotent read once after resetting the daemon', async () => {
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

  it('freezes the launch configuration until a reset asks for it again', async () => {
    expect(configurationSignature('cn')).toBe(configurationSignature('cn'))

    // The daemon compares one configuration for the life of the process, so a
    // change on the machine must NOT silently produce a second one: it is
    // picked up only after the daemon is reset.
    const before = configurationSignature('cn')
    const previous = process.env.QODERCN_CLI_PATH
    process.env.QODERCN_CLI_PATH = process.execPath
    try {
      expect(configurationSignature('cn')).toBe(before)

      await resetDaemon('cn')
      expect(configurationSignature('cn')).not.toBe(before)
    } finally {
      if (previous === undefined) delete process.env.QODERCN_CLI_PATH
      else process.env.QODERCN_CLI_PATH = previous
      await resetDaemon('cn')
    }
    expect(configurationSignature('cn')).toBe(before)
  })
})