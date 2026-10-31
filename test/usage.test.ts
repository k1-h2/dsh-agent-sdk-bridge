/**
 * A quota reading must describe *this* machine.
 *
 * The page keeps the last good reading visible when a refresh fails — right for
 * a dropped network, wrong after an uninstall. The account, plan and credits in
 * that snapshot were read through a CLI that is no longer installed, so the
 * card showed "li yu / Free / 0 of 900 credits" for an account nobody could
 * reproduce. The host now says `cliMissing` explicitly, and the page drops the
 * stored reading instead of labelling it "last reading".
 */
import { describe, expect, it } from 'vitest'
import { resolveQoderCli } from '../src/cli.ts'
import { QoderUsage } from '../src/usage.ts'

describe('quota reading without a CLI', () => {
  // The international CLI is optional on this project's machines; when it does
  // happen to be installed the case cannot be staged without uninstalling it.
  const missing = resolveQoderCli('global') === undefined

  it.skipIf(!missing)('answers cliMissing instead of a cached account reading', async () => {
    const usage = new QoderUsage('global')
    const snapshot = await usage.read()
    expect(snapshot.cliMissing).toBe(true)
    // Not one number from a previous install may survive.
    expect(snapshot.usage).toBeUndefined()
    expect(snapshot.account).toBeUndefined()
    expect(snapshot.error).toContain('qodercli')

    // `fresh` is the page's refresh button: it must answer the same thing, not
    // fall back to a remembered snapshot.
    expect((await usage.read(true)).cliMissing).toBe(true)
  })
})
