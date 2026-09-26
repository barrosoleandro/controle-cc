import { describe, expect, it } from 'vitest'
import { countryOf, flowsByCountry, type Country, type FlowTx } from '../src/domain/countries'

describe('by-country analysis', () => {
  it('maps banks to countries', () => {
    expect(['ITAU', 'BCP', 'CCF', 'MILLENNIUM', 'Wise'].map(countryOf)).toEqual(['Brasil', 'França', 'França', 'Portugal', 'Outro'])
  })

  it('sums income and spending per month and country, without transfers or months outside the window', () => {
    const acc = new Map<string, Country>([['itau', 'Brasil'], ['card', 'Brasil'], ['bcp', 'França']])
    const t = (account_id: string, month: string, value: number, kind: string): FlowTx => ({ account_id, month, value, kind })
    const f = flowsByCountry([
      t('bcp', '2026-08', 11000, 'income'),
      t('bcp', '2026-08', -3500, 'expense'),
      t('bcp', '2026-08', 50, 'expense'), // refund lowers spending
      t('bcp', '2026-08', -4000, 'transfer'),
      t('card', '2026-08', -800, 'expense'),
      t('itau', '2026-08', 800, 'transfer'), // card bill paid from checking
      t('itau', '2026-07', 100, 'income'),
      t('itau', '2024-01', 999, 'income'),
      t('unknown', '2026-08', 5, 'income'),
    ], acc, ['2026-07', '2026-08'])
    expect(f.countries).toEqual(['Brasil', 'França'])
    expect(f.cell('2026-08', 'França')).toEqual({ income: 11000, expense: 3450 })
    expect(f.cell('2026-08', 'Brasil')).toEqual({ income: 0, expense: 800 })
    expect(f.totals('Brasil')).toEqual({ income: 100, expense: 800 })
    expect(f.cell('2026-07', 'França')).toEqual({ income: 0, expense: 0 })
  })
})
