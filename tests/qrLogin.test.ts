import { describe, expect, it } from 'vitest'
import { approveUrl, describeAgent, formatPairCode, normalizePairCode, qrError } from '../src/domain/qrLogin'
import * as fn from '../supabase/functions/qr-login/index'

const seq = (...xs: number[]) => { let i = 0; return (n: number) => xs[i++ % xs.length] % n }

describe('pair code', () => {
  it('accepts the QR url, the formatted code and loose typing; rejects ambiguous or short codes', () => {
    expect(normalizePairCode('https://controle-cc.vercel.app/?aprovar=K7M2Q9XD')).toBe('K7M2Q9XD')
    expect(normalizePairCode('k7m2-q9xd')).toBe('K7M2Q9XD')
    expect(normalizePairCode(' K7M2 Q9XD ')).toBe('K7M2Q9XD')
    expect(normalizePairCode('K7M2Q9X0')).toBeNull() // 0 is not in the alphabet (looks like O)
    expect(normalizePairCode('K7M2Q9X')).toBeNull()
    expect(normalizePairCode('')).toBeNull()
  })
  it('is the same rule in the app and in the Edge Function', () => {
    expect(fn.PAIR_ALPHABET).toBe('23456789ABCDEFGHJKMNPQRSTUVWXYZ')
    for (const raw of ['https://x.app/?aprovar=K7M2Q9XD', 'k7m2-q9xd', 'K7M2Q9X0', 'abc', 'ZZZZ ZZZZ', '/?a=1&aprovar=ab-cd-ef-gh#x'])
      expect(fn.normalizePairCode(raw)).toBe(normalizePairCode(raw))
  })
  it('round-trips what the laptop shows and what the QR carries', () => {
    const code = fn.randomPairCode(seq(0, 5, 30, 12, 7, 19, 3, 22))
    expect(code).toHaveLength(8)
    expect(normalizePairCode(formatPairCode(code))).toBe(code)
    expect(normalizePairCode(approveUrl('https://controle-cc.vercel.app', code))).toBe(code)
  })
})

describe('number matching', () => {
  it('offers three distinct numbers, one of them the right one', () => {
    for (const r of [seq(0), seq(1, 2, 3), seq(89, 0, 45, 7)]) {
      const c = fn.matchChoices(42, r)
      expect(c).toHaveLength(3)
      expect(new Set(c).size).toBe(3)
      expect(c).toContain(42)
      for (const n of c) expect(n >= 10 && n <= 99).toBe(true)
    }
  })
})

describe('session checks in the Edge Function', () => {
  const now = 1_800_000_000
  it('approves only right after biometrics or the authenticator code', () => {
    expect(fn.freshMfa([{ method: 'password', timestamp: now }, { method: 'totp', timestamp: now - 60 }], now)).toBe(true)
    expect(fn.freshMfa([{ method: 'mfa/webauthn', timestamp: now - 10 }], now)).toBe(true)
    expect(fn.freshMfa([{ method: 'totp', timestamp: now - 3600 }], now)).toBe(false) // aal2 from this morning is not enough
    expect(fn.freshMfa([{ method: 'password', timestamp: now }], now)).toBe(false)
    expect(fn.freshMfa(['totp'], now)).toBe(false) // no timestamp: cannot tell it is recent
    expect(fn.freshMfa(undefined, now)).toBe(false)
  })
  it('binds only the session created by this request’s login token', () => {
    expect(fn.loggedInSince([{ method: 'magiclink', timestamp: now + 3 }], now)).toBe(true)
    expect(fn.loggedInSince([{ method: 'otp', timestamp: now }], now)).toBe(true)
    expect(fn.loggedInSince([{ method: 'password', timestamp: now + 3 }], now)).toBe(false)
    expect(fn.loggedInSince([{ method: 'magiclink', timestamp: now - 600 }], now)).toBe(false) // an older session
  })
  it('reads the claims of a JWT', () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const token = `${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', aal: 'aal1', session_id: 's1' })}.sig`
    expect(fn.decodeJwt(token)).toMatchObject({ sub: 'u1', aal: 'aal1', session_id: 's1' })
    expect(fn.decodeJwt('garbage')).toBeNull()
  })
})

describe('what the phone shows', () => {
  it('names the requesting device', () => {
    expect(describeAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0'))
      .toEqual({ os: 'Windows', browser: 'Edge' })
    expect(describeAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'))
      .toEqual({ os: 'macOS', browser: 'Safari' })
    expect(describeAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1').os).toBe('iOS')
  })
  it('explains the server’s error codes', () => {
    expect(qrError('numero_errado')).toMatch(/cancelado/)
    expect(qrError('xyz')).toMatch(/xyz/)
  })
})
