import { describe, expect, it } from 'vitest'
import { categorize, merchantKey, patternMatches } from '../src/domain/categorize'
import { DEFAULT_BANK_MAP, DEFAULT_CATEGORIES, DEFAULT_RULES } from '../src/domain/defaults'
import { detectSubscriptions } from '../src/domain/subscriptions'
import { grossToNet } from '../src/domain/tax'
import { runScenario, type Scenario } from '../src/domain/simulation'
import { FxTable } from '../src/domain/fx'

const cat = (description: string, amount: number, bankCategory?: string, bankSubcategory?: string) =>
  categorize({ description, amount, bankCategory, bankSubcategory }, DEFAULT_RULES, DEFAULT_BANK_MAP)

describe('category mapping', () => {
  it('every rule and bank-map target is a defined category', () => {
    const names = new Set(DEFAULT_CATEGORIES.map((c) => c.name))
    for (const r of DEFAULT_RULES) expect(names, r.pattern).toContain(r.category)
    for (const m of DEFAULT_BANK_MAP) expect(names, m.bank_subcategory).toContain(m.category)
  })
  it('merchant rules win over bank categories', () => {
    expect(cat('CB PICARD SA FACT 290826', -51.57, 'Alimentation', 'Hyper/supermarche')).toBe('Picard')
    expect(cat('CB ZALANDO PAYMENT', -40, 'Alimentation', 'Hyper/supermarche')).toBe('Compras online')
    expect(cat('CB AMAZON PRIME FR FACT 060826', -69.9, 'Shopping et services', 'Shopping et services - autre')).toBe('Streaming')
    expect(cat('CB AMAZON PAYMENTS', -20, 'Shopping et services', 'Shopping et services - autre')).toBe('Compras online')
  })
  it('falls back to bank category map, then default', () => {
    expect(cat('CB CARREFOURMARKET', -47, 'Alimentation', 'Hyper/supermarche')).toBe('Mercado')
    expect(cat('CB SOMEWHERE', -12, 'Transports', 'Taxis et VTC')).toBe('Transporte')
    expect(cat('CB HOTEL', -99, 'Loisirs et vacances', 'Hotel')).toBe('Viagem')
    expect(cat('PIX TRANSF UNKNOWN', -100)).toBe('Outros')
    expect(cat('PIX TRANSF UNKNOWN', 100)).toBe('Outras receitas')
  })
  it('income, transfers and Brazil', () => {
    expect(cat('VIR SEPA VALLOUREC TUBES', 11623.2)).toBe('Salario')
    expect(cat('VIR SEPA WHITE BIRD', -3550.75)).toBe('Aluguel')
    expect(cat('VIR SEPA M. BARROSO OLIVEIRA O', -5000)).toBe('Transfer')
    expect(cat('PIX TRANSF Wise Br09/09', 2515.58)).toBe('Transfer')
    expect(cat('PERS INFINIT 7609-0945', -25996.24)).toBe('Cartão Itaú')
    expect(cat('01- IOF CAMBIO', -159.93)).toBe('Conta')
    expect(cat('302OP REC EXT', 28779)).toBe('Transfer')
  })
  it('word-boundary matching avoids false positives', () => {
    expect(patternMatches('PAG TAXA MUNICIPAL', 'AXA')).toBe(false)
    expect(patternMatches('PRLV AXA FRANCE', 'AXA')).toBe(true)
  })
  it('merchant key strips noise', () => {
    expect(merchantKey('CB CARREFOURMARKET FACT 210926')).toBe('CARREFOURMARKET')
    expect(merchantKey('CB DL*UberRides FACT 070826 (EN BRL 28,98)')).toBe('DL UBERRIDES')
    expect(merchantKey('PIX TRANSF FRANCIS21/09')).toBe('FRANCIS')
  })
})

describe('subscription detection', () => {
  const monthly = (merchant: string, amount: number, n: number, start = '2026-01-05') =>
    Array.from({ length: n }, (_, i) => {
      const d = new Date(start); d.setUTCMonth(d.getUTCMonth() + i)
      return { booking_date: d.toISOString().slice(0, 10), amount: -amount, merchant, kind: 'expense' }
    })
  it('finds a monthly charge and flags a price increase', () => {
    const txs = [...monthly('NETFLIX', 13.49, 7), { booking_date: '2026-08-05', amount: -15.99, merchant: 'NETFLIX', kind: 'expense' }]
    const [s] = detectSubscriptions(txs, '2026-08-20')
    expect(s.merchant).toBe('NETFLIX'); expect(s.cadence).toBe('monthly')
    expect(s.priceChangePct).toBeGreaterThan(0.15)
    expect(s.nextDate).toBe('2026-09-05')
  })
  it('ignores irregular merchants', () => {
    const txs = [5, 9, 30, 31, 70].map((d) => ({ booking_date: `2026-0${1 + Math.floor(d / 30)}-${String((d % 28) + 1).padStart(2, '0')}`, amount: -(d * 3 + 10), merchant: 'SHOP', kind: 'expense' }))
    expect(detectSubscriptions(txs, '2026-06-01')).toHaveLength(0)
  })
  it('marks stopped subscriptions', () => {
    const [s] = detectSubscriptions(monthly('GYM', 44, 4), '2026-09-01')
    expect(s.status).toBe('possibly_cancelled')
  })
})

describe('tax model sanity (orders of magnitude)', () => {
  const h = { married: true, children: 2 }
  it('net is below gross and rates are plausible', () => {
    for (const c of ['FR', 'PT', 'LU'] as const) {
      const r = grossToNet(c, 150000, h)
      expect(r.netMonth).toBeGreaterThan(6500)
      expect(r.netMonth).toBeLessThan(10000)
      expect(r.effectiveRate).toBeGreaterThan(0.2)
      expect(r.effectiveRate).toBeLessThan(0.5)
    }
  })
  it('progressivity: effective rate grows with income', () => {
    for (const c of ['FR', 'PT', 'LU', 'BR'] as const)
      expect(grossToNet(c, 300000, h).effectiveRate).toBeGreaterThan(grossToNet(c, 60000, h).effectiveRate)
  })
  it('Brazil: exempt up to R$5k/month, INSS capped', () => {
    const low = grossToNet('BR', 5000 * (13 + 1 / 3), { married: false, children: 0 })
    expect(low.incomeTax).toBe(0)
    const hi = grossToNet('BR', 50000 * (13 + 1 / 3), { married: false, children: 0 })
    expect(hi.social / (13 + 1 / 3)).toBeCloseTo(988.09, 0)
  })
  it('PT IFICI flat 20% beats the progressive scale at high income', () => {
    expect(grossToNet('PT', 200000, { ...h, ptIfici: true }).netMonth).toBeGreaterThan(grossToNet('PT', 200000, h).netMonth)
  })
})

describe('simulation', () => {
  const s: Scenario = { name: 't', country: 'CUSTOM', household: { married: true, children: 0, customEffectiveRate: 0.4 }, grossYear: 120000, partnerGrossYear: 0,
    otherIncomeMonth: 0, rentMonth: 2000, schoolYear: 12000, baselineVariableMonth: 2000, costOfLivingIndex: 1, extraLines: [{ name: 'x', monthly: 100 }],
    savingsReturnPct: 0, inflationPct: 0, years: 2, startingSavings: 1000, fxEurBrl: 6 }
  it('computes surplus and linear projection at 0% return', () => {
    const r = runScenario(s)
    expect(r.incomeMonth).toBe(6000)
    expect(r.expenses.total).toBe(5100)
    expect(r.surplusMonth).toBe(900)
    expect(r.projection[1].savings).toBe(1000 + 900 * 24)
  })
})

describe('fx', () => {
  it('uses the latest rate on or before the date', () => {
    const fx = new FxTable(new Map([['2026-01-02', 6], ['2026-01-05', 6.5]]))
    expect(fx.eurBrl('2026-01-04')).toBe(6)
    expect(fx.convert(65, 'BRL', 'EUR', '2026-01-06')).toBe(10)
    expect(fx.eurBrl('2025-12-01')).toBe(6)
  })
})
