import { describe, expect, it } from 'vitest'
import { addMonths, looksLikeItauCardXlsx, parseItauCardXlsx, type Cell } from '../src/parsers/itauCardXlsx'
import { looksLikeMillenniumPdf, looksLikeMillenniumReceipt, parseMillenniumPdf } from '../src/parsers/millenniumPdf'
import { CARD_PAYMENT, categorize } from '../src/domain/categorize'
import { billPayment, matchCardPayments } from '../src/domain/cards'
import { withFingerprints } from '../src/domain/fingerprint'
import type { Account } from '../src/domain/types'

// Synthetic fixtures mirroring the real layouts (no personal data).
const d = (s: string) => new Date(`${s}T00:00:00.000Z`)
const _ = null
function fatura(title: string, total: Cell, due: Cell, lines: Cell[][]): Cell[][] {
  return [
    [_, _, _], [_, 'Nome', 'Fulano'], [_, 'Agência', '1234'], [_, 'Conta', '05555-0'], [_],
    [_, title],
    [_, 'Cartão', _, _, _, _, 'Valor', _, 'Vencimento', _],
    [_, 'Personnalite Infinite Visa - final 9999', _, _, _, _, total, _, due, _],
    [_, 'Lançamentos'],
    [_, 'Data', 'Lançamento', 'Parcelamento', 'Valor', _, 'Titularidade', 'Nome', 'Tipo do cartão', 'Número do cartão'],
    ...lines,
    [_, _, _, 'Subtotal'],
    [_, 'Importante saber'],
  ]
}
const LINES: Cell[][] = [
  [_, d('2026-02-11'), 'Pagamento Efetuado', _, -500, _, 'Titular', 'F', 'Físico', '****0001'],
  [_, d('2026-03-01'), 'Netflix.com', _, 59.9, _, 'Titular', 'F', 'Virtual recorrente', '****0002'],
  [_, d('2025-12-31'), 'Loja X            ', 'Parcela 3 de 5', 100.1, _, 'Adicional', 'C', 'Wallet', '****0003'],
  [_, d('2026-02-20'), 'Iof Compra Internaciona', _, 0.5, 'USD 1,00', 'Titular', 'F', 'Físico', '****0002'],
  [_, d('2026-02-20'), 'Loja X', _, -0.5, _, 'Titular', 'F', 'Físico', '****0002'],
]

describe('Itaú card xlsx', () => {
  it('parses a paid bill: purchases negative, payment as CARD_PAYMENT, instalment dated in its billing month', () => {
    const rows = fatura('Fatura Paga - Março/2026', 160, d('2026-03-11'), LINES)
    expect(looksLikeItauCardXlsx(rows)).toBe(true)
    const r = parseItauCardXlsx(rows)
    expect(r.warnings).toEqual([])
    expect(r.accounts?.[0]).toMatchObject({ ref: 'ITAUCARD-9999', type: 'card', parentRef: '1234/005555-0', currency: 'BRL' })
    expect(r.cardStatements).toEqual([{ accountRef: 'ITAUCARD-9999', dueDate: '2026-03-11', total: 160, status: 'paga' }])
    expect(r.transactions).toHaveLength(5)
    expect(r.transactions[0]).toMatchObject({ amount: 500, bankCategory: CARD_PAYMENT })
    expect(r.transactions[1]).toMatchObject({ amount: -59.9, bookingDate: '2026-03-01', statementDue: '2026-03-11' })
    expect(r.transactions[2]).toMatchObject({ description: 'Loja X (3/5)', bookingDate: '2026-02-28', valueDate: '2025-12-31', amount: -100.1 })
    expect(r.transactions[4].amount).toBe(0.5)
  })

  it('warns when the rows do not add up to the bill', () => {
    const r = parseItauCardXlsx(fatura('Fatura Paga - Março/2026', '999.00', '2026-03-11T00:00:00.000Z', LINES))
    expect(r.warnings.join()).toMatch(/difere/)
  })

  it('does not import "fatura próxima" (future instalments only)', () => {
    const r = parseItauCardXlsx(fatura('Fatura Próxima - Dezembro/2026', '0', d('2026-12-11'), LINES.slice(2, 3)))
    expect(r.transactions).toEqual([])
    expect(r.cardStatements).toBeUndefined()
    expect(r.warnings.join()).toMatch(/próxima/)
  })

  it('keeps an open bill as "aberta" and each parcela gets its own fingerprint', () => {
    const r = parseItauCardXlsx(fatura('Fatura Aberta - Outubro/2026', '11165.91', d('2026-10-11'), [
      [_, d('2026-01-10'), 'Loja Y', 'Parcela 9 de 10', 50, _, 'Titular', 'F', 'Wallet', '****1'],
      [_, d('2026-01-10'), 'Loja Y', 'Parcela 10 de 10', 50, _, 'Titular', 'F', 'Wallet', '****1'],
    ]))
    expect(r.cardStatements?.[0]).toMatchObject({ status: 'aberta', total: 11165.91 })
    const fp = withFingerprints(r.transactions, (x) => x).map((t) => t.fingerprint)
    expect(new Set(fp).size).toBe(2)
  })

  it('addMonths clamps to month end', () => {
    expect(addMonths('2025-12-31', 2)).toBe('2026-02-28')
    expect(addMonths('2026-01-15', 0)).toBe('2026-01-15')
    expect(addMonths('2025-11-30', 3)).toBe('2026-02-28')
  })
})

const MILLENNIUM = [
  '26/07/31   CONTA:   11122233344   NIB:   #S#000#E#',
  'EXTRATO COMBINADO',
  'CONTA MILLENNIUM   N. 11122233344   MOEDA:   EUR',
  'EXTRATO DE 2026/12/01 A 2027/01/05',
  'LANC. VALOR   DESCRITIVO   DEBITO   CREDITO   SALDO',
  'SALDO INICIAL   1 725.08',
  '12.03   12.03   COM.MAN.CONTA PACOTE PROGRAMA PRESTIGE   062026   8.00   1 717.08',
  '12.27   12.25   TRF P/ SOMEONE   600.00   1 117.08',
  '1.02   1.02   TRF DE SOMEONE   1 000.00   2 117.08',
  'SALDO FINAL   2 117.08',
]

describe('Millennium bcp extrato combinado', () => {
  it('parses signs from the running balance and crosses the new year', () => {
    expect(looksLikeMillenniumPdf(MILLENNIUM)).toBe(true)
    const r = parseMillenniumPdf(MILLENNIUM)
    expect(r.warnings).toEqual([])
    expect(r.accounts?.[0]).toMatchObject({ ref: '11122233344', bank: 'MILLENNIUM', currency: 'EUR' })
    expect(r.transactions.map((t) => [t.bookingDate, t.amount, t.description])).toEqual([
      ['2026-12-03', -8, 'COM.MAN.CONTA PACOTE PROGRAMA PRESTIGE 062026'],
      ['2026-12-27', -600, 'TRF P/ SOMEONE'],
      ['2027-01-02', 1000, 'TRF DE SOMEONE'],
    ])
    expect(r.checkpoints).toContainEqual({ accountRef: '11122233344', date: '2026-11-30', balance: 1725.08 })
    expect(r.checkpoints).toContainEqual({ accountRef: '11122233344', date: '2027-01-02', balance: 2117.08 })
  })

  it('recognises single-operation receipts', () => {
    expect(looksLikeMillenniumReceipt(['Nota de Lançamento', 'Nr.Doc. 1'])).toBe(true)
  })
})

describe('categorization for cards', () => {
  it('card bill payments are always transfers', () => {
    expect(categorize({ description: 'Pagamento Efetuado', amount: 500, bankCategory: CARD_PAYMENT }, [], [])).toBe('Transfer')
  })
  it('learned letter-only rules match descriptions with digits in between', () => {
    const rules = [{ pattern: 'PAG SERV BANCO', category: 'Conta', priority: 1 }]
    expect(categorize({ description: 'PAG SERV 21489/020986822 BANCO COMERCIAL', amount: -150 }, rules, [])).toBe('Conta')
    expect(categorize({ description: 'TAXA', amount: -1 }, [{ pattern: 'AXA', category: 'X', priority: 1 }], [])).toBe('Outros')
  })
})

describe('matchCardPayments', () => {
  const acc = (id: string, type: Account['type'], parent?: string): Account => ({
    id, name: id, bank: 'ITAU', currency: 'BRL', type, external_ref: id, opening_balance: 0, opening_date: null, is_active: true, parent_account_id: parent ?? null,
  })
  const txs = [
    { id: 'p1', account_id: 'card', booking_date: '2026-09-11', amount: 25996.24, bank_category: CARD_PAYMENT },
    { id: 'buy', account_id: 'card', booking_date: '2026-09-12', amount: -25996.24, bank_category: null }, // a purchase, not a payment
    { id: 'a', account_id: 'chk', booking_date: '2026-09-11', amount: -25996.24 },
    { id: 'b', account_id: 'chk', booking_date: '2026-08-11', amount: -25996.24 }, // too far
    { id: 'c', account_id: 'other', booking_date: '2026-09-11', amount: -25996.24 },
  ]
  it('pairs the payment on the card with the same-amount debit in the paying account, once', () => {
    const m = matchCardPayments([acc('chk', 'checking'), acc('card', 'card', 'chk')], txs)
    expect(m.map((x) => [x.cardTx.id, x.bankTx.id])).toEqual([['p1', 'a']])
  })
  it('does nothing for an unlinked card', () => {
    expect(matchCardPayments([acc('chk', 'checking'), acc('card', 'card')], txs)).toEqual([])
  })
  it('finds the payment that settled a bill', () => {
    const bill = { account_id: 'card', due_date: '2026-09-11', total: 25996.24, status: 'paga' as const }
    expect(billPayment(bill, txs)?.id).toBe('p1')
  })
})
