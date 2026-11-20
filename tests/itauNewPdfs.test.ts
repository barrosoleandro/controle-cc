import { describe, expect, it } from 'vitest'
import { looksLikeItauAccountPdf, parseItauAccountPdf } from '../src/parsers/itauAccountPdf'
import { looksLikeItauCardBillPdf, parseItauCardBillPdf } from '../src/parsers/itauCardBillPdf'
import { looksLikeItauCardPdf } from '../src/parsers/itauCardPdf'
import { looksLikeItauPdf } from '../src/parsers/itauPdf'
import { sameVendor } from '../src/domain/fingerprint'
import { CARD_PAYMENT } from '../src/domain/categorize'
import { rowsToLines, type Row } from '../src/parsers/pdfText'

// Made-up statements in the bank's layout: each row is [x, text] cells.
const row = (y: number, ...cells: [number, string][]): Row => ({ y, cells: cells.map(([x0, str]) => ({ x0, x1: x0 + str.length * 4, str })) })

describe('Itaú "Extrato conta corrente" PDF', () => {
  const pages: Row[][] = [[
    row(780, [323, 'CPF: 00000000000'], [419, 'agência: 1234'], [481, 'conta: 0005555-0']),
    row(537, [40, 'Extrato conta corrente']),
    row(419, [40, 'Data'], [100, 'Lançamentos'], [256, 'Descrição'], [416, 'Valor (R$)'], [500, 'Saldo (R$)']),
    row(392, [40, '19/11/2026'], [525, '41,49']),
    row(367, [40, '19/11/2026'], [100, 'PIX RECEBIDO'], [256, 'FULANA DE'], [433, '560,00']),
    row(350, [256, 'TAL']),
    row(325, [40, '18/11/2026'], [521, '518,51']), // negative, printed without its sign
    row(258, [40, '18/11/2026'], [100, 'PAGAMENTO DE BOLETO'], [256, 'PLANO DE SAUDE'], [430, '-883,23']),
    row(93, [40, '09/11/2026'], [511, '364,72']),
    row(69, [40, '09/11/2026'], [100, 'DÉBITO AUTOMÁTICO'], [256, 'PERS INFINIT 0000-0000'], [427, '-1.234,56']),
    row(50, [40, '07/11/2026'], [100, 'PAGAMENTO DE PIX QR'], [256, 'CEMIG DISTRIBUICAO S.A'], [432, '-192,62']),
    row(40, [100, 'CODE']),
  ], [
    row(783, [40, 'Data'], [100, 'Lançamentos'], [256, 'Descrição'], [416, 'Valor (R$)'], [500, 'Saldo (R$)']),
    row(756, [40, '04/11/2026'], [508, '1.791,90']),
    row(468, [40, 'Posição consolidada']),
    row(405, [40, 'saldo disponível sem investimentos automáticos'], [516, 'R$ 1,00']),
  ]]
  const lines = rowsToLines(pages)
  const r = parseItauAccountPdf(pages, lines)

  it('is recognised, and not as the older exports', () => {
    expect(looksLikeItauAccountPdf(lines)).toBe(true)
    expect(looksLikeItauPdf(lines)).toBe(false)
    expect(r.transactions[0].accountRef).toBe('1234/005555-0')
  })

  it('books rows on the day of their balance, in the older export wording, oldest first', () => {
    expect(r.transactions.map((t) => [t.bookingDate, t.valueDate, t.description, t.amount])).toEqual([
      ['2026-11-09', '2026-11-07', 'PIX QRS CEMIG DISTRIBUICAO S.A', -192.62],
      ['2026-11-09', '2026-11-09', 'PERS INFINIT 0000-0000', -1234.56],
      ['2026-11-18', '2026-11-18', 'PAG BOLETO PLANO DE SAUDE', -883.23],
      ['2026-11-19', '2026-11-19', 'PIX TRANSF FULANA DE TAL', 560],
    ])
  })

  it('keeps the daily balances, restoring the sign of an overdrawn day', () => {
    expect(r.checkpoints.map((c) => [c.date, c.balance])).toEqual([
      ['2026-11-19', 41.49], ['2026-11-18', -518.51], ['2026-11-09', 364.72], ['2026-11-04', 1791.9],
    ])
    expect(r.warnings).toEqual([])
  })
})

describe('Itaú card bill PDF (fatura aberta / próxima)', () => {
  const header = (kind: string, value: string, due: string) => [
    row(695, [28, 'FULANO DE TAL'], [298, 'agência'], [354, 'conta corrente']),
    row(687, [28, '000.000.000-00'], [298, '1234'], [354, '05555-0']),
    row(650, [28, 'fatura de']),
    row(644, [489, 'emitido em 20/11/2026 às 18:01:05']),
    row(581, [28, 'fatura'], [67, 'valor até o momento'], [165, 'venc. da fatura']),
    row(567, [28, kind], [67, value], [165, due]),
  ]
  const open: Row[][] = [[
    ...header('aberta', 'R$ 718,34', '11/12/2026'),
    row(502, [28, 'total da fatura anterior']),
    row(463, [36, '11 / nov'], [150, 'PAGAMENTO EFETUADO'], [515, '- R$ 1.234,56']),
    row(438, [36, '-'], [150, 'total da fatura anterior'], [520, 'R$ 1.234,56']),
    row(367, [28, 'lançamentos nacionais']),
    row(327, [28, ''], [45, 'fulano de tal - final 2222 (titular)']),
    row(295, [36, 'data'], [160, 'lançamento'], [540, 'valor']),
    row(267, [36, '15 / jul'], [160, 'Azulxnib8t 05/06'], [526, 'R$ 450,65']),
    row(168, [36, '05 / nov'], [160, 'Netflix.com'], [530, 'R$ 59,90']),
    row(60, [28, 'total nacional do cartão - final 2222 (titular)'], [527, 'R$ 510,55']),
    row(40, [28, ''], [45, 'beltrano - final 3333 (adicional)']),
    row(30, [36, '16 / mai'], [160, 'Vivara Tellerina C05/10'], [530, 'R$ 192,91']),
  ], [
    row(598, [28, 'lançamentos internacionais']),
    row(559, [28, ''], [45, 'beltrano - final 3333 (adicional)']),
    row(498, [36, '16 / nov'], [160, 'dólar de conversão'], [534, 'R$ 6,10']),
    row(474, [160, 'Lime*payoff Asbh'], [530, 'R$ 14,88']),
    row(450, [160, 'Valor em dólar'], [532, 'US$2,44']),
    row(426, [160, 'France'], [529, 'EUR'], [545, '2,20']),
    row(369, [28, 'total internacional do cartão - final 3333 (adicional)'], [537, 'R$ 14,88']),
    row(748, [28, 'total (nacional'], [81, '+ internacional'], [135, '+ encargos)'], [527, 'R$ 718,34']),
  ]]
  const lines = rowsToLines(open)
  const r = parseItauCardBillPdf(open, lines, 'Fatura_PERSONNALITE_VISA_INFINITE_1111_2026_12.pdf')

  it('is recognised, and not as the older bill layout', () => {
    expect(looksLikeItauCardBillPdf(lines)).toBe(true)
    expect(looksLikeItauCardPdf(lines)).toBe(false)
  })

  it('takes the card from the file name and links it to the paying account', () => {
    expect(r.accounts).toEqual([expect.objectContaining({ ref: 'ITAUCARD-1111', parentRef: '1234/005555-0', type: 'card' })])
    expect(r.cardStatements).toEqual([{ accountRef: 'ITAUCARD-1111', dueDate: '2026-12-11', status: 'aberta', total: 718.34 }])
  })

  it('reads the payment, instalments by month billed, each card and foreign purchases', () => {
    expect(r.transactions.map((t) => [t.bookingDate, t.description, t.amount, t.bankCategory ?? t.bankSubcategory])).toEqual([
      ['2026-11-11', 'PAGAMENTO EFETUADO', 1234.56, CARD_PAYMENT],
      ['2026-11-15', 'Azulxnib8t (5/6)', -450.65, 'cartão final 2222'],
      ['2026-11-05', 'Netflix.com', -59.9, 'cartão final 2222'],
      ['2026-09-16', 'Vivara Tellerina C (5/10)', -192.91, 'cartão final 3333'],
      ['2026-11-16', 'Lime*payoff Asbh', -14.88, 'cartão final 3333'],
    ])
    expect(r.warnings).toEqual([])
  })

  it('reads but does not import a "fatura próxima"', () => {
    const next: Row[][] = [[
      ...header('próxima', 'R$ 553,00', '11/01/2027'),
      row(502, [28, 'compras parceladas']),
      row(462, [28, ''], [45, 'fulano de tal - final 1111']),
      row(402, [36, '01 / agosto'], [160, 'Yes Cadeira Moveis (06/10)'], [526, 'R$ 553,00']),
    ]]
    const n = parseItauCardBillPdf(next, rowsToLines(next), 'x_1111_2027_01.pdf')
    expect(n.transactions).toEqual([])
    expect(n.warnings[0]).toMatch(/próxima/)
  })
})

describe('sameVendor with names cut short', () => {
  it('matches the older export truncating a name', () => {
    expect(sameVendor('PIX TRANSF MARIAN21/09', 'PIX TRANSF MARIANA SOUZA')).toBe(true)
  })
  it('still tells two different names apart', () => {
    expect(sameVendor('PIX TRANSF MARIA', 'PIX TRANSF JOANA')).toBe(false)
  })
})
