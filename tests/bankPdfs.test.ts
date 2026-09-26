import { describe, expect, it } from 'vitest'
import { looksLikeItauMonthlyPdf, parseItauMonthlyPdf } from '../src/parsers/itauMonthlyPdf'
import { looksLikeCcfPdf, parseCcfPdf } from '../src/parsers/ccfPdf'
import { rowsToLines, type Row } from '../src/parsers/pdfText'

// Made-up statements in each bank's layout: each row is [x, text] cells.
const row = (y: number, ...cells: [number, string][]): Row => ({ y, cells: cells.map(([x0, str]) => ({ x0, x1: x0 + str.length * 4, str })) })

describe('Itaú monthly statement (Extrato Mensal)', () => {
  const pages: Row[][] = [[
    row(790, [407, 'extrato'], [427, 'mensal'], [466, 'ag 7824 cc 07765-0'], [514, 'abr 2025']),
    row(780, [340, 'saldo em 31/03/25'], [440, 'saldo em 30/04/25']),
    row(770, [532, 'total'], [820, '1.030,62']),
    row(760, [532, 'total'], [820, '686,00']),
    row(497, [56, 'Conta Corrente |'], [107, 'Movimentação']),
    row(476, [56, 'A = agendamento'], [150, 'data'], [207, 'descrição'], [357, 'entradas R$'], [426, 'saídas R$'], [520, 'saldo R$']),
    row(459, [150, '31/03'], [207, 'Saldo anterior'], [517, '1.000,00']),
    row(436, [56, 'D = débito a compensar'], [150, '03/04'], [207, 'PIX QRS Pagarme Pag03/04'], [440, '36,00-']),
    row(426, [207, 'Res Aplic Aut Mais'], [379, '35,96']),
    row(416, [207, 'Rend Pago Aplic Aut Mais'], [383, '0,62'], [535, '1,00']),
    row(405, [207, 'Saldo Aplic Aut Mais'], [517, '963,62']),
    row(382, [150, '07/04'], [207, 'DI Resgate CDB'], [366, '1.030,00']),
    row(372, [207, 'PIX TRANSF ALEXAND07/04'], [426, '650,00-']),
    row(362, [207, 'Apl Aplic Aut Mais'], [430, '380,00-'], [535, '1,00']),
    row(352, [207, 'Saldo final'], [517, '1.344,62']),
    row(340, [207, 'totalizador de aplicações automáticas']),
    row(330, [207, 'PIX DEPOIS DO FIM'], [426, '99,00-']),
  ]]
  const lines = rowsToLines(pages)
  const r = parseItauMonthlyPdf(pages, lines)

  it('is recognised and reads the account as in the app export', () => {
    expect(looksLikeItauMonthlyPdf(lines)).toBe(true)
    expect(r.source).toBe('itau_monthly_pdf')
    expect(r.transactions[0].accountRef).toBe('7824/007765-0')
  })

  it('keeps real movements and yield, leaves out the sweeps and balances, and checks the totals', () => {
    expect(r.transactions.map((t) => [t.bookingDate, t.description, t.amount])).toEqual([
      ['2025-04-03', 'PIX QRS Pagarme Pag03/04', -36],
      ['2025-04-03', 'Rend Pago Aplic Aut Mais', 0.62],
      ['2025-04-07', 'DI Resgate CDB', 1030],
      ['2025-04-07', 'PIX TRANSF ALEXAND07/04', -650],
    ])
    expect(r.checkpoints).toEqual([
      { accountRef: '7824/007765-0', date: '2025-03-31', balance: 1000 },
      { accountRef: '7824/007765-0', date: '2025-04-30', balance: 1344.62 },
    ])
    expect(r.warnings).toEqual([])
  })
})

describe('CCF statement', () => {
  const statement: Row[][] = [[
    row(799, [264, 'Relevé COMPTE CHEQUES 2']),
    row(786, [264, 'COMPTE CHEQUE']),
    row(762, [264, 'Arrêté au 07 janvier 2025']),
    row(714, [45, 'Votre Agence CCF de : CCF PARIS ODEON']),
    row(542, [58, 'NUMÉRO DE COMPTE'], [143, '18079 75293 04192637741 31']),
    row(461, [54, 'ANCIEN SOLDE CRÉDITEUR AU 07 DÉCEMBRE 2024'], [508, '4 643,39'], [548, '¤']),
    row(437, [54, '30/12'], [86, '30/12/2024'], [135, 'CARTE 28/12 CARREFOURMARKET CROISSY SUR S'], [447, '66,17']),
    row(426, [34, 'Émis le 08/01/2025 Réf : MRELDEB'], [54, '02/01'], [86, '31/12/2024 CARTE 31/12 UBER'], [213, '*EATS HELP.UBER.COM'], [443, '82,97']),
    row(416, [135, 'Taux de change appliqué'], [247, '+'], [262, '1,07766']),
    row(405, [54, '03/01'], [86, '03/01/2025'], [135, 'VIR VALLOUREC TUBES'], [529, '1 905,19']),
    row(300, [59, 'TOTAL DES OPÉRATIONS DU RELEVÉ'], [435, '149,14'], [524, '1 905,19']),
    row(290, [58, 'NOUVEAU SOLDE CRÉDITEUR AU 07 JANVIER 2025'], [514, '6 399,44 €']),
  ]]
  const lines = rowsToLines(statement)
  const r = parseCcfPdf(statement, lines)

  it('reads account, debits and credits by column, year across new year, and balances', () => {
    expect(looksLikeCcfPdf(lines)).toBe(true)
    expect(r.accounts).toEqual([{ ref: 'CCF-41926377-41', name: 'CCF Compte chèques 2', bank: 'CCF', currency: 'EUR', type: 'checking' }])
    expect(r.transactions.map((t) => [t.bookingDate, t.description, t.amount])).toEqual([
      ['2024-12-30', 'CARTE 28/12 CARREFOURMARKET CROISSY SUR S', -66.17],
      ['2025-01-02', 'CARTE 31/12 UBER *EATS HELP.UBER.COM', -82.97], // value date 2024, booked in 2025
      ['2025-01-03', 'VIR VALLOUREC TUBES', 1905.19],
    ])
    expect(r.checkpoints.map((c) => [c.date, c.balance])).toEqual([['2024-12-07', 4643.39], ['2025-01-07', 6399.44]])
    expect(r.warnings).toEqual([])
  })

  it('ignores CCF letters without transactions', () => {
    const letter: Row[][] = [[row(700, [45, 'CCF PARIS ODEON']), row(600, [45, 'INFORMATIONS GÉNÉRALES SUR LA PROTECTION DES DÉPÔTS'])]]
    expect(parseCcfPdf(letter, rowsToLines(letter)).source).toBe('ignored')
  })
})
