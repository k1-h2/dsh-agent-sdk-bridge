/**
 * CodeBuddy's own per-region snapshot on disk.
 *
 * The SDK's browser login returns a bearer token, but it is only available in
 * the process that ran the login. Saving it here is what lets a later process
 * switch back to a region and use the account immediately instead of opening
 * the browser again. The account and quota reading are saved alongside it so
 * the settings card can paint before a fresh CLI read finishes.
 *
 * The file is per-user, mode 0600, and contains a bearer credential: do not log
 * it or copy it into bug reports.
 *
 * @module dsh-agent-sdk-bridge/codebuddy-state
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CodeBuddyRegion } from './brand.ts'
import type {
  CodeBuddyAccount, CodeBuddyQuota, CodeBuddyUsageSnapshot,
} from './codebuddy.ts'

/** The signed-in identity remembered for one region. */
export interface CodeBuddySavedUser {
  userId: string
  userName: string
  userNickname: string
}

/** Everything remembered for one login region. */
export interface CodeBuddySavedRegion {
  /** Bearer credential from the SDK login, used to restore the login. */
  token?: string
  user?: CodeBuddySavedUser
  signedIn?: boolean
  account?: CodeBuddyAccount
  quota?: CodeBuddyQuota
  quotaError?: string
  /** When the account snapshot was last written. */
  at?: number
}

interface SavedFile {
  version: 1
  regions: Partial<Record<CodeBuddyRegion, CodeBuddySavedRegion>>
}

/**
 * The default file path.
 *
 * `DSH_HOME` is honoured so a desktop profile and a web profile keep separate
 * credentials; `DSH_CODUBUDDY_STATE_PATH` exists for tests and power users.
 */
function defaultPath(): string {
  const override = process.env.DSH_CODUBUDDY_STATE_PATH
  if (override !== undefined && override.length > 0) return override
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'agent-sdk-bridge', 'codebuddy-state.json')
}

/**
 * One CLI user-data directory per login region.
 *
 * The bundled CLI remembers its product environment inside this directory and
 * only switches it during initialize, after the model provider has already
 * chosen a catalog. Two regions sharing the default `~/.codebuddy` therefore
 * read each other's catalogs after a switch, and the wrong list got cached for
 * five minutes. A separate directory fixes the environment per region, so every
 * boot reads its own catalog. `DSH_CODUBUDDY_CLI_DIR` exists for tests.
 */
export function codeBuddyCliDir(region: CodeBuddyRegion): string {
  const override = process.env.DSH_CODUBUDDY_CLI_DIR
  const root = override !== undefined && override.length > 0
    ? override
    : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'agent-sdk-bridge', 'codebuddy-cli')
  const dir = join(root, region)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** The per-user file behind {@link CodeBuddyStateStore}. */
export class CodeBuddyStateStore {
  private loaded = false
  private state: SavedFile = { version: 1, regions: {} }

  constructor(private readonly file: string = defaultPath()) {}

  private ensureLoaded(): SavedFile {
    if (this.loaded) return this.state
    this.loaded = true
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<SavedFile>
      if (parsed.version === 1 && parsed.regions !== null && typeof parsed.regions === 'object') {
        this.state = { version: 1, regions: parsed.regions }
      }
    } catch {
      // A missing or unreadable file is the normal first-run state.
    }
    return this.state
  }

  region(region: CodeBuddyRegion): CodeBuddySavedRegion | undefined {
    return this.ensureLoaded().regions[region]
  }

  /** The stored bearer token, or undefined when the region is signed out. */
  token(region: CodeBuddyRegion): string | undefined {
    const token = this.region(region)?.token
    return typeof token === 'string' && token.length > 0 ? token : undefined
  }

  user(region: CodeBuddyRegion): CodeBuddySavedUser | undefined {
    return this.region(region)?.user
  }

  signedIn(region: CodeBuddyRegion): boolean {
    return this.region(region)?.signedIn === true
  }

  /** The saved account reading, in the shape the usage route returns. */
  usage(region: CodeBuddyRegion): CodeBuddyUsageSnapshot | undefined {
    const saved = this.region(region)
    if (saved === undefined || saved.at === undefined || saved.signedIn !== true) return undefined
    return {
      at: saved.at,
      ...saved.account === undefined ? {} : { account: saved.account },
      ...saved.quota === undefined ? {} : { quota: saved.quota },
      ...saved.quotaError === undefined ? {} : { quotaError: saved.quotaError },
    }
  }

  /** Merge fields into one region and write the file; `undefined` deletes. */
  patch(region: CodeBuddyRegion, patch: Partial<CodeBuddySavedRegion>): void {
    const state = this.ensureLoaded()
    const next: CodeBuddySavedRegion = { ...state.regions[region] }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key as keyof CodeBuddySavedRegion]
      else (next as Record<string, unknown>)[key] = value
    }
    state.regions[region] = next
    this.persist()
  }

  /**
   * Drop only the credential, keeping the last account reading.
   *
   * An expired token must stop being used for sessions, while the card can
   * still show which account expired so the user knows what to sign into.
   */
  clearToken(region: CodeBuddyRegion): void {
    const state = this.ensureLoaded()
    const saved = state.regions[region]
    if (saved === undefined) return
    delete saved.token
    saved.signedIn = false
    this.persist()
  }

  /** Forget one region entirely: logout and expired credentials both land here. */
  clear(region: CodeBuddyRegion): void {
    const state = this.ensureLoaded()
    delete state.regions[region]
    this.persist()
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const temporary = `${this.file}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 })
      try {
        chmodSync(temporary, 0o600)
      } catch {
        // Windows applies the directory ACL instead; mode is best-effort there.
      }
      renameSync(temporary, this.file)
    } catch {
      // Losing the cache only costs a fresh CLI read, never the login itself.
    }
  }
}
