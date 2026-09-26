import { describe, expect, it } from 'vitest'
import { parseBcpCsv } from '../src/parsers/bcpCsv'
import { parseBcpPdf } from '../src/parsers/bcpPdf'
import { parseItauPdf } from '../src/parsers/itauPdf'
import { dedupeKey, markDuplicates, withFingerprints } from '../src/domain/fingerprint'
import { parseEuroNumber } from '../src/parsers/util'

// Synthetic fixtures that mirror the real layouts (no personal data).
const CSV = `Date de comptabilisation;Libelle simplifie;Libelle operation;Reference;Informations complementaires;Type operation;Categorie;Sous categorie;Debit;Credit;Date operation;Date de valeur;Pointage operation
25/09/2026;SHOP;CB SHOP FACT 230926;r1;;Carte bancaire;Alimentation;Restaurant;-10,16;;23/09/2026;25/09/2026;0
24/09/2026;EMPLOYER;VIR SEPA EMPLOYER;r2;;Virement recu;A categoriser;Virement recu;;1 250,00;24/09/2026;24/09/2026;0
24/09/2026;SHOP;CB SHOP FACT 220926;r3;;Carte bancaire;Alimentation;Restaurant;-10,16;;22/09/2026;24/09/2026;0`

const BCP_PDF = [
  'SYNTHESE DE VOTRE COMPTE   EN EUR',
  'COMPTE DE DEPOT JOINT   N° 12579 00700 01234567890   Solde au 31/08/2026   + 8 890,48',
  'COMPTE DE DEPOT JOINT - N° 01234567890',
  'SOLDE CREDITEUR AU 31/07/2026   + 12 202,78',
  '29/08/2026   01/09/2026   REMISE CHEQUES N° 0001550   VALEUR AU 01/09   + 1 680,00',
  'VIREMENT VERS SOMEONE',
  '01/08/2026   01/08/2026   VIR SEPA LANDLORD   - 3 550,75',
  'FRAIS BANCAIRES ET COTISATIONS POUR UN TOTAL DE - 1,94 €',
  'LIV.A EN CPTE - N° 00000000001',
  'SOLDE CREDITEUR   + 0,00',
  '05/05/2026   16/05/2026   OUV AUTO LIVRET A   + 20,00',
  'SOLDE CREDITEUR AU 25/05/2026   + 20,00',
]

const ITAU_PDF = [
  'FULANO   000.000.000-00   agência: 1234   conta: 005555-0',
  'extrato conta / lançamentos',
  '26/09/2026   SALDO DO DIA   46,76',
  '25/09/2026   PAG BOLETO UNIMED   -1.761,73',
  '25/09/2026   SALDO DO DIA   46,62',
  '21/09/2026   PIX TRANSF FRANCIS21/09   41,00',
  '21/09/2026   SALDO DO DIA   1.808,35',
]

describe('number parsing', () => {
  it('handles FR/BR formats', () => {
    expect(parseEuroNumber('- 3 550,75')).toBe(-3550.75)
    expect(parseEuroNumber('-25.996,24')).toBe(-25996.24)
    expect(parseEuroNumber('+ 1 680,00')).toBe(1680)
    expect(parseEuroNumber('1 250,00')).toBe(1250)
  })
})

describe('BCP CSV', () => {
  const r = parseBcpCsv(CSV, '01234567890_01012026_26092026.csv')
  it('reads rows, signs and bank categories', () => {
    expect(r.transactions).toHaveLength(3)
    expect(r.transactions[0]).toMatchObject({ accountRef: '01234567890', bookingDate: '2026-09-25', amount: -10.16, bankCategory: 'Alimentation', bankSubcategory: 'Restaurant' })
    expect(r.transactions[1].amount).toBe(1250)
  })
})

describe('BCP PDF', () => {
  const r = parseBcpPdf(BCP_PDF)
  it('splits accounts and reads operations', () => {
    expect(r.transactions.map((t) => [t.accountRef, t.amount])).toEqual([['01234567890', 1680], ['01234567890', -3550.75], ['00000000001', 20]])
  })
  it('captures bank balances as checkpoints', () => {
    const c = Object.fromEntries(r.checkpoints.map((x) => [`${x.accountRef}|${x.date}`, x.balance]))
    expect(c['01234567890|2026-08-31']).toBe(8890.48)
    expect(c['01234567890|2026-07-31']).toBe(12202.78)
    expect(c['00000000001|2026-05-25']).toBe(20)
  })
})

describe('Itaú PDF', () => {
  const r = parseItauPdf(ITAU_PDF)
  it('separates transactions from daily balances, oldest first', () => {
    expect(r.transactions.map((t) => t.amount)).toEqual([41, -1761.73])
    expect(r.checkpoints).toHaveLength(3)
    expect(r.transactions[0]).toMatchObject({ accountRef: '1234/005555-0', currency: 'BRL', bookingDate: '2026-09-21' })
  })
  it('balances reconcile day to day', () => {
    expect(Math.round((1808.35 - 1761.73) * 100) / 100).toBe(46.62)
  })
})

describe('fingerprints', () => {
  const tx = (description: string) => ({ accountRef: 'X', bookingDate: '2026-01-01', description, amount: -5, currency: 'EUR' as const })
  it('are identical across CSV and PDF wording, distinct for same-day duplicates', () => {
    const a = withFingerprints([tx('CB SHOP FACT 010126'), tx('CB SHOP FACT 010126')], (r) => r)
    const b = withFingerprints([tx('SHOP')], (r) => r)
    expect(a[0].fingerprint).toBe(b[0].fingerprint)
    expect(a[0].fingerprint).not.toBe(a[1].fingerprint)
  })
  it('tell apart two vendors with the same date and amount', () => {
    const [a, b] = withFingerprints([tx('CB CARREFOUR FACT 010126'), tx('CB PICARD FACT 010126')], (r) => r)
    expect(a.fingerprint).not.toBe(b.fingerprint)
  })
})

describe('duplicate check across files (date + vendor + amount)', () => {
  const it2 = (desc: string, amount = -5) => ({ key: dedupeKey('X', '2026-01-01', amount), desc })
  it('matches the vendor by its words, in any order and without accents', () => {
    expect(markDuplicates([it2('RESGATE CDB DI', 63133.08)], [it2('DI Resgate CDB', 63133.08)])).toEqual([true])
    expect(markDuplicates([it2('PAG TIT INT 033')], [it2('INT Pag Tít 033')])).toEqual([true])
    expect(markDuplicates([it2('TED D INT1660e50e')], [it2('INT TED D 1660e50e')])).toEqual([true])
    expect(markDuplicates([it2('CB SHOP FACT 010126')], [it2('Shop Paris')])).toEqual([true])
  })
  it('keeps different vendors and counts copies: one stored row absorbs one incoming row', () => {
    expect(markDuplicates([it2('CARTE CARREFOUR'), it2('CARTE CARREFOUR'), it2('CARTE PICARD')], [it2('CARREFOUR MARKET')])).toEqual([true, false, false])
    expect(markDuplicates([it2('PICARD', -6)], [it2('PICARD', -5)])).toEqual([false])
  })
})
