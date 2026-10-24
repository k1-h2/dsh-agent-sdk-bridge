import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodeBuddyStateStore } from '../src/codebuddy-state.ts'

function temporaryStore(): { store: CodeBuddyStateStore, file: string, cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'codebuddy-state-'))
  const file = join(directory, 'state.json')
  return {
    store: new CodeBuddyStateStore(file),
    file,
    cleanup: () => { rmSync(directory, { recursive: true, force: true }) },
  }
}

describe('CodeBuddy state store', () => {
  it('restores both regions from disk in a new instance', () => {
    const { store, file, cleanup } = temporaryStore()
    try {
      store.patch('cn', {
        token: 'cn-token',
        signedIn: true,
        user: { userId: 'u1', userName: 'dev', userNickname: 'dev' },
        account: { email: 'cn@example.com' },
        at: 11,
      })
      store.patch('global', {
        token: 'global-token',
        signedIn: true,
        account: { email: 'global@example.com' },
        at: 12,
      })

      const reopened = new CodeBuddyStateStore(file)
      expect(reopened.token('cn')).toBe('cn-token')
      expect(reopened.user('cn')).toMatchObject({ userId: 'u1' })
      expect(reopened.usage('cn')).toMatchObject({ at: 11, account: { email: 'cn@example.com' } })
      expect(reopened.token('global')).toBe('global-token')
      expect(reopened.signedIn('global')).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('drops a credential without losing the account card', () => {
    const { store, cleanup } = temporaryStore()
    try {
      store.patch('cn', {
        token: 'expired',
        signedIn: true,
        user: { userId: 'u1', userName: 'dev', userNickname: 'dev' },
        account: { email: 'cn@example.com' },
        at: 11,
      })
      store.clearToken('cn')
      expect(store.token('cn')).toBeUndefined()
      expect(store.signedIn('cn')).toBe(false)
      expect(store.user('cn')).toMatchObject({ userId: 'u1' })
      // A signed-out region must not serve an account snapshot as current.
      expect(store.usage('cn')).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  it('clears one region without touching the other', () => {
    const { store, file, cleanup } = temporaryStore()
    try {
      store.patch('cn', { token: 'cn-token', signedIn: true, at: 1 })
      store.patch('global', { token: 'global-token', signedIn: true, at: 2 })
      store.clear('cn')
      expect(store.token('cn')).toBeUndefined()
      expect(store.token('global')).toBe('global-token')
      expect(JSON.parse(readFileSync(file, 'utf8')).regions).not.toHaveProperty('cn')
    } finally {
      cleanup()
    }
  })
})
