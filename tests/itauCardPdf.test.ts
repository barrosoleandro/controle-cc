import { describe, expect, it } from 'vitest'
import { looksLikeItauCardPdf, parseItauCardPdf } from '../src/parsers/itauCardPdf'
import { rowsToLines, type Row } from '../src/parsers/pdfText'

// Made-up bill in the Itaú two-column layout: each row is [x, text] cells.
const row = (y: number, ...cells: [number, string][]): Row => ({ y, cells: cells.map(([x0, str]) => ({ x0, x1: x0 + str.length * 4, str })) })

const summary: Row[] = [
  row(800, [155, 'Resumo da fatura em R$']),
  row(790, [371, 'Pagamento efetuado em 10/09/2025'], [541, '- 1.000,00']),
  row(780, [371, 'Lançamentos atuais'], [530, '1.371,50']),
  row(770, [155, 'Vencimento: 11/10/2025']),
  row(760, [371, 'Total desta fatura'], [525, '1.371,50']),
  row(750, [155, 'Emissão: 04/10/2025']),
  row(740, [155, 'Cartão'], [200, '4771.XXXX.XXXX.1377 VISA INFINITE']),
]
const lancamentos: Row[] = [
  row(655, [155, 'Lançamentos: compras e saques'], [371, 'Lançamentos: compras e saques']),
  row(646, [155, 'CAROL (final 8482)'], [371, '04/08'], [398, 'LOJA MOVEIS 02/10'], [539, '220,00']),
  row(637, [155, 'DATA'], [182, 'ESTABELECIMENTO'], [304, 'VALOR EM R$'], [398, 'DIVERSOS .BELO HORIZONT']),
  row(628, [155, '30/07'], [182, 'A SERENATA'], [232, '03/04'], [327, '92,50'], [371, 'Compras parceladas - próximas faturas']),
  row(619, [182, 'HOBBY .BELO HORIZONT'], [371, '07/09'], [398, 'TAP WEB VIP 02/10'], [539, '5.079,90']),
  row(610, [155, '18/08'], [182, 'COMERCIAL BIEL LTDA'], [327, '- 0,01']),
  row(601, [155, 'Lançamentos no cartão (final 8482)'], [320, '92,49']),
  row(592, [155, 'LEANDRO (final 1377)']),
  row(583, [155, '11/09'], [182, 'DL *GOOGLE YouTubePrem'], [327, '26,90']),
  row(574, [182, 'TURISMO E ENTRETENIM.SAO PAULO']),
]
// Last page: the international block and the total, after both columns above.
const fim: Row[] = [
  row(565, [155, 'Lançamentos internacionais']),
  row(556, [155, '05/09'], [182, 'CARREFOURMARKET'], [327, '100,00']),
  row(547, [182, 'CROISSY SUR S'], [240, '19,14'], [270, 'EUR'], [300, '22,34']),
  row(538, [155, 'Repasse de IOF em R$'], [329, '3,50']),
  row(529, [146, 'L'], [155, 'Total dos lançamentos atuais'], [309, '1.371,50']),
  row(520, [155, '01/10'], [182, 'DEPOIS DO TOTAL'], [327, '999,00']),
]

describe('Itaú card bill (PDF)', () => {
  const pages = [summary, lancamentos, fim]
  const lines = rowsToLines(pages)
  const r = parseItauCardPdf(pages, lines, '2026-01-01')

  it('is recognised and reads the bill header', () => {
    expect(looksLikeItauCardPdf(lines)).toBe(true)
    expect(r.source).toBe('itau_card_pdf')
    expect(r.accounts?.[0].ref).toBe('ITAUCARD-1377')
    expect(r.cardStatements).toEqual([{ accountRef: 'ITAUCARD-1377', dueDate: '2025-10-11', status: 'paga', total: 1371.5 }])
  })

  it('reads both columns, instalments, categories, holders and the IOF, and stops at the total', () => {
    const byDesc = new Map(r.transactions.map((t) => [t.description, t]))
    expect(byDesc.get('A SERENATA (3/4)')).toMatchObject({ bookingDate: '2025-09-30', valueDate: '2025-07-30', amount: -92.5, bankCategory: 'HOBBY', bankSubcategory: 'BELO HORIZONT · cartão final 8482' })
    expect(byDesc.get('LOJA MOVEIS (2/10)')).toMatchObject({ bookingDate: '2025-09-04', amount: -220, bankCategory: 'DIVERSOS' })
    expect(byDesc.get('COMERCIAL BIEL LTDA')?.amount).toBe(0.01)
    expect(byDesc.get('DL *GOOGLE YouTubePrem')).toMatchObject({ bankCategory: 'TURISMO E ENTRETENIM', bankSubcategory: 'SAO PAULO · cartão final 1377' })
    expect(byDesc.get('CARREFOURMARKET')?.bankSubcategory).toBe('CROISSY SUR S 19,14 EUR 22,34 · cartão final 1377')
    expect(byDesc.get('REPASSE DE IOF (INTERNACIONAL)')).toMatchObject({ bookingDate: '2025-10-04', amount: -3.5 })
    expect(byDesc.has('TAP WEB VIP (2/10)')).toBe(false) // future instalments
    expect(byDesc.has('DEPOIS DO TOTAL')).toBe(false)
  })

  it('takes the payment from the summary when there is no payments section, and checks the sum', () => {
    const pay = r.transactions.filter((t) => t.bankCategory === 'PAGAMENTO FATURA')
    expect(pay).toEqual([expect.objectContaining({ bookingDate: '2025-09-10', amount: 1000 })])
    expect(r.warnings).toEqual(['Soma dos lançamentos (442.89) difere dos lançamentos atuais da fatura (1371.50).'])
  })
})
