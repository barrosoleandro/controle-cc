import type { AccountHint, CardStatement, ParseResult, ParsedTransaction } from '../domain/types'
import { CARD_PAYMENT } from '../domain/categorize'
import { round2 } from './util'

/** A spreadsheet cell as read-excel-file returns it. */
export type Cell = string | number | boolean | Date | null | undefined

const clean = (c: Cell) => (c == null ? '' : String(c).replace(/\s+/g, ' ').trim())
const fold = (c: Cell) => clean(c).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

function isoDate(c: Cell): string | null {
  if (c instanceof Date && !Number.isNaN(c.getTime())) return c.toISOString().slice(0, 10)
  const s = clean(c)
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s)
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null
}

function num(c: Cell): number | null {
  if (typeof c === 'number') return round2(c)
  const s = clean(c).replace(/R\$|\s/g, '')
  if (!s) return null
  // '18342.81' (xlsx text) or '18.342,81' (typed by hand)
  const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s)
  return Number.isFinite(n) ? round2(n) : null
}

/** Same day k-1 months later, clamped to the month's last day (parcela k of a purchase). */
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const first = new Date(Date.UTC(y, m - 1 + months, 1))
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
  first.setUTCDate(Math.min(d, last))
  return first.toISOString().slice(0, 10)
}

/** Itaú checking refs are stored as 7824/007765-0; the card export says Conta 07765-0. */
function checkingRef(agencia: string, conta: string): string | undefined {
  const m = /^(\d+)-(\d)$/.exec(conta)
  return agencia && m ? `${agencia}/${m[1].padStart(6, '0')}-${m[2]}` : undefined
}

export function looksLikeItauCardXlsx(rows: Cell[][]): boolean {
  return rows.slice(0, 20).some((r) => r.some((c) => /^fatura (paga|aberta|proxima)\b/.test(fold(c))))
}

/**
 * Itaú credit-card bill exported from the app/site as .xlsx ("fatura-paga-final 1377-…").
 * Purchases become negative amounts (money out) on a card account linked to the Itaú
 * checking account; "Pagamento Efetuado" becomes a CARD_PAYMENT credit (a transfer).
 * Instalments are booked in the month they are billed: parcela k of a purchase made on
 * day D is dated D + (k-1) months, so each parcela has its own date and fingerprint.
 * "Fatura próxima" files only hold future instalments: they are read but not imported.
 */
export function parseItauCardXlsx(rows: Cell[][]): ParseResult {
  const warnings: string[] = []
  const labelValue = (label: string) => {
    for (const r of rows) {
      const i = r.findIndex((c) => fold(c) === label)
      if (i >= 0) return clean(r.slice(i + 1).find((c) => clean(c) !== ''))
    }
    return ''
  }
  const title = rows.flat().map(fold).find((c) => /^fatura (paga|aberta|proxima)\b/.test(c)) ?? ''
  const kind = /^fatura (paga|aberta|proxima)/.exec(title)?.[1] as 'paga' | 'aberta' | 'proxima' | undefined

  // Summary block: "Cartão | … | Valor | … | Vencimento" and the row under it.
  let last4 = '', total: number | null = null, due: string | null = null
  const cardHdr = rows.findIndex((r) => r.some((c) => fold(c) === 'cartao'))
  if (cardHdr >= 0) {
    const hdr = rows[cardHdr].map(fold)
    const val = rows[cardHdr + 1] ?? []
    const iCard = hdr.indexOf('cartao')
    const iVal = hdr.findIndex((h) => h.startsWith('valor'))
    const iDue = hdr.indexOf('vencimento')
    last4 = /final (\d{4})/i.exec(clean(val[iCard]))?.[1] ?? ''
    total = iVal >= 0 ? num(val[iVal]) : null
    due = iDue >= 0 ? isoDate(val[iDue]) : null
  }
  if (!last4) throw new Error('Fatura Itaú: número final do cartão não encontrado.')
  if (!due) throw new Error('Fatura Itaú: data de vencimento não encontrada.')

  const accountRef = `ITAUCARD-${last4}`
  const parentRef = checkingRef(labelValue('agencia'), labelValue('conta'))
  const accounts: AccountHint[] = [{
    ref: accountRef, name: `Itaú cartão final ${last4}`, bank: 'ITAU', currency: 'BRL', type: 'card', parentRef,
  }]
  if (!parentRef) warnings.push('Agência/conta não encontradas: vincule o cartão à conta em Cartões.')

  // Transactions table: header row with Data | Lançamento | Parcelamento | Valor.
  const h = rows.findIndex((r) => r.map(fold).includes('lancamento') && r.map(fold).includes('data'))
  if (h < 0) throw new Error('Fatura Itaú: tabela de lançamentos não encontrada.')
  const hdr = rows[h].map(fold)
  const col = { date: hdr.indexOf('data'), desc: hdr.indexOf('lancamento'), parc: hdr.indexOf('parcelamento'), val: hdr.indexOf('valor') }

  const transactions: ParsedTransaction[] = []
  for (const r of rows.slice(h + 1)) {
    const date = isoDate(r[col.date])
    const value = num(r[col.val])
    const desc = clean(r[col.desc])
    if (!date || value === null || !desc) continue // subtotal, notes, blank lines
    const p = /parcela (\d+) de (\d+)/i.exec(clean(r[col.parc]))
    const k = p ? Number(p[1]) : 1
    const payment = value < 0 && /^(pagamento efetuado|credito de pagamento)/i.test(desc)
    transactions.push({
      accountRef,
      bookingDate: p ? addMonths(date, k - 1) : date,
      valueDate: date,
      description: p ? `${desc} (${k}/${p[2]})` : desc,
      amount: round2(-value), // bank shows purchases as positive
      currency: 'BRL',
      bankCategory: payment ? CARD_PAYMENT : undefined,
      statementDue: due,
    })
  }

  if (kind === 'proxima') {
    warnings.push('Fatura próxima: só parcelas futuras — não importada.')
    return { source: 'itau_card_xlsx', transactions: [], checkpoints: [], warnings, accounts }
  }
  const billed = round2(transactions.filter((t) => t.bankCategory !== CARD_PAYMENT).reduce((s, t) => s - t.amount, 0))
  if (total !== null && Math.abs(billed - total) > 0.05)
    warnings.push(`Soma dos lançamentos (${billed.toFixed(2)}) difere do total da fatura (${total.toFixed(2)}).`)
  const cardStatements: CardStatement[] = [{
    accountRef, dueDate: due, status: kind === 'paga' ? 'paga' : 'aberta', total: total ?? billed,
  }]
  return { source: 'itau_card_xlsx', transactions, checkpoints: [], warnings, accounts, cardStatements }
}
