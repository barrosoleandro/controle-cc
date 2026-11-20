import { describe, expect, it } from 'vitest'
import { accessError, approveUrl, describeAgent, formatPairCode, normalizePairCode, PLAN_TEXT } from '../src/domain/access'
import * as fn from '../supabase/functions/household-access/index'

const seq = (...xs: number[]) => { let i = 0; return (n: number) => xs[i++ % xs.length] % n }

describe('pair code', () => {
  it('accepts the QR url, the formatted code and loose typing; rejects ambiguous or short codes', () => {
    expect(normalizePairCode('https://controle-cc.vercel.app/?aprovar=K7M2Q9XD')).toBe('K7M2Q9XD')
    expect(normalizePairCode('k7m2-q9xd')).toBe('K7M2Q9XD')
    expect(normalizePairCode(' K7M2 Q9XD ')).toBe('K7M2Q9XD')
    expect(normalizePairCode('K7M2Q9X0')).toBeNull() // 0 is not in the alphabet (looks like O)
    expect(normalizePairCode('K7M2Q9X')).toBeNull()
  })
  it('is the same rule in the app and in the Edge Function', () => {
    expect(fn.PAIR_ALPHABET).toBe('23456789ABCDEFGHJKMNPQRSTUVWXYZ')
    for (const raw of ['https://x.app/?aprovar=K7M2Q9XD', 'k7m2-q9xd', 'K7M2Q9X0', 'abc', 'ZZZZ ZZZZ', '/?a=1&aprovar=ab-cd-ef-gh#x'])
      expect(fn.normalizePairCode(raw)).toBe(normalizePairCode(raw))
  })
  it('round-trips what the new device shows and what the QR carries', () => {
    const code = fn.randomPairCode(seq(0, 5, 30, 12, 7, 19, 3, 22))
    expect(normalizePairCode(formatPairCode(code))).toBe(code)
    expect(normalizePairCode(approveUrl('https://controle-cc.vercel.app', code))).toBe(code)
  })
})

describe('number matching', () => {
  it('offers three distinct numbers, one of them the right one, even with a stuck random source', () => {
    for (const r of [seq(0), seq(1, 2, 3), seq(89, 0, 45, 7)]) {
      const c = fn.matchChoices(42, r)
      expect(new Set(c).size).toBe(3)
      expect(c).toContain(42)
      for (const n of c) expect(n >= 10 && n <= 99).toBe(true)
    }
  })
})

describe('who can be let in', () => {
  const OWNER = 'o', MEMBER = 'm', STRANGER = 's'
  it('creates a new e-mail as a member of the approver’s household', () => {
    expect(fn.approvalPlan({ approverId: OWNER, approverOwner: null, target: null })).toBe('create')
  })
  it('signs in the owner or one of the owner’s members', () => {
    expect(fn.approvalPlan({ approverId: OWNER, approverOwner: null, target: { id: OWNER, owner: null } })).toBe('login')
    expect(fn.approvalPlan({ approverId: OWNER, approverOwner: null, target: { id: MEMBER, owner: OWNER } })).toBe('login')
  })
  it('refuses an account outside the household and approvals by a member', () => {
    expect(fn.approvalPlan({ approverId: OWNER, approverOwner: null, target: { id: STRANGER, owner: null } })).toBe('conta_de_outra_casa')
    expect(fn.approvalPlan({ approverId: OWNER, approverOwner: null, target: { id: MEMBER, owner: 'x' } })).toBe('conta_de_outra_casa')
    expect(fn.approvalPlan({ approverId: MEMBER, approverOwner: OWNER, target: null })).toBe('so_dono')
  })
  it('has a message for every plan', () => {
    for (const p of ['create', 'login', 'so_dono', 'conta_de_outra_casa']) expect(PLAN_TEXT[p]).toBeTruthy()
  })
})

describe('inputs', () => {
  it('normalizes e-mails and rejects junk', () => {
    expect(fn.normalizeEmail('  Ana@Exemplo.com ')).toBe('ana@exemplo.com')
    expect(fn.normalizeEmail('ana@exemplo')).toBeNull()
    expect(fn.normalizeEmail('')).toBeNull()
    expect(fn.normalizeEmail(undefined)).toBeNull()
  })
  it('reads the claims of a JWT', () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
    expect(fn.decodeJwt(`${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', session_id: 's1' })}.sig`)).toMatchObject({ sub: 'u1', session_id: 's1' })
    expect(fn.decodeJwt('garbage')).toBeNull()
  })
  it('names the requesting device and explains errors', () => {
    expect(describeAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toEqual({ os: 'iOS', browser: 'Safari' })
    expect(accessError('numero_errado')).toMatch(/cancelado/)
    expect(accessError('xyz')).toMatch(/xyz/)
  })
})
