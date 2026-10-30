import { describe, expect, it } from 'vitest'
import { auditRows, unpairedTransfers, type AuditStored, type PairTx } from '../src/domain/audit'
import type { ParsedTransaction } from '../src/domain/types'

const p = (bookingDate: string, amount: number, description: string, accountRef = '04033573329'): ParsedTransaction =>
  ({ accountRef, bookingDate, amount, description, currency: 'EUR' })
const s = (id: string, date: string, amount: number, description: string, accountRef = '04033573329'): AuditStored =>
  ({ id, accountRef, accountName: 'BCP', date, amount, description })

describe('import audit', () => {
  it('a row counts as stored only with the same description; same date and amount otherwise is "similar"', () => {
    const rows = auditRows(
      [p('2026-10-22', 1000, 'VIR. VERS CPT DEPOT PART.'), p('2026-10-22', 1000, 'VIR SEPA LOYER'), p('2026-10-23', -12.5, 'CB PADARIA'), p('2026-10-24', -5, 'X', '999')],
      [s('1', '2026-10-22', 1000, 'VIR SEPA LOYER'), s('2', '2026-10-23', -12.5, 'CB  Padaria')],
      new Set(['04033573329']),
    )
    expect(rows.map((r) => r.status)).toEqual(['missing', 'ok', 'ok', 'noAccount'])
  })

  it('reports a stored row with another description as similar, with that row', () => {
    const [r] = auditRows([p('2026-10-22', 1000, 'VIR. VERS CPT DEPOT PART.')], [s('9', '2026-10-22', 1000, 'VIREMENT INTERNE')], new Set(['04033573329']))
    expect(r).toMatchObject({ status: 'similar', match: { id: '9', description: 'VIREMENT INTERNE' } })
  })

  it('two equal rows in the file need two stored rows', () => {
    const rows = auditRows([p('2026-10-01', -3, 'CAFE'), p('2026-10-01', -3, 'CAFE')], [s('1', '2026-10-01', -3, 'CAFE')], new Set(['04033573329']))
    expect(rows.map((r) => r.status)).toEqual(['ok', 'missing'])
  })
})

describe('transfers between own accounts', () => {
  const t = (id: string, account_id: string, date: string, amount: number, kind = 'transfer', currency = 'EUR'): PairTx => ({ id, account_id, date, amount, currency, description: id, kind })
  const fx = (amount: number, from: string, to: string) => (from === to ? amount : from === 'EUR' ? amount * 6 : amount / 6)

  it('pairs money out of one account with money into another, within a few days', () => {
    const out = unpairedTransfers([t('in', 'cc', '2026-10-22', 1000), t('out', 'livret', '2026-10-21', -1000)], fx)
    expect(out).toEqual([])
  })

  it('flags a transfer whose other side is missing (the savings account not imported)', () => {
    expect(unpairedTransfers([t('in', 'cc', '2026-10-22', 1000)], fx).map((x) => x.id)).toEqual(['in'])
  })

  it('does not pair within the same account, with the same sign, or too far apart', () => {
    // a/b: same account · c/d: both money in · e: 19 days after a
    const out = unpairedTransfers([t('a', 'cc', '2026-10-01', 500), t('b', 'cc', '2026-10-01', -500), t('c', 'x', '2026-10-01', 70), t('d', 'y', '2026-10-01', 70), t('e', 'z', '2026-10-20', -500)], fx)
    expect(out.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('pairs across currencies at the rate, within 3%', () => {
    expect(unpairedTransfers([t('eur', 'bcp', '2026-10-05', -400), t('brl', 'itau', '2026-10-07', 2380, 'transfer', 'BRL')], fx)).toEqual([])
    expect(unpairedTransfers([t('eur', 'bcp', '2026-10-05', -400), t('brl', 'itau', '2026-10-07', 2000, 'transfer', 'BRL')], fx)).toHaveLength(2)
  })

  it('each row answers for one transfer only', () => {
    const out = unpairedTransfers([t('a', 'cc', '2026-10-01', 100), t('b', 'cc', '2026-10-02', 100), t('c', 'sv', '2026-10-01', -100)], fx)
    expect(out.map((x) => x.id)).toEqual(['b'])
  })
})
